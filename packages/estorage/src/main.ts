import { fetchDBFileBytes, listDBDir, listDBs, uploadDBZip } from "./estorageClient";
import LightningFS from "@isomorphic-git/lightning-fs";

console.log("LOADED ESTORAGE");

(window as any).getNewRepos = async () => {
    let dbs = await listDBs();
    let arrs = [];
    for (const db of dbs) {
        arrs.push({ name: db, bytes: await fetchDBFileBytes(db, "db.sqlite") });
    }

    return arrs;
};

(window as any).downloadAssets = async (dbs: Array<{ name: string }>) => {
    for (const dbObj of dbs) {
        const db = dbObj.name;
        try {
            let assetFiles = await listDBDir(db, "assets");
            let pfs = (new LightningFS("logseq_files", {
                wipe: false,
                url: undefined,
                urlauto: false,
                fileDbName: "logseq",
                fileStoreName: "logseq_files",
                defer: false,
                db: undefined,
            })).promises;

            try {
                let stats = await pfs.stat(`/${db}`);
                if (stats.type !== "dir") {
                    throw new Error("Path exists but is not a directory");
                }
            }
            catch {
                try {
                    await pfs.mkdir(`/${db}`);
                }
                catch {
                    console.error(`Failed to make a lightningfs ${db} folder`);
                }
            }

            for (const assetFile of assetFiles) {

                try {
                    let stats = await pfs.stat(`/${db}/assets/${assetFile.name}`);
                    if (stats.type !== "file") {
                        throw new Error("Path exists but is not a asset file");
                    }
                }
                catch {
                    try {
                        let data = await fetchDBFileBytes(db, `assets/${assetFile.name}`);
                        await pfs.writeFile(`/${db}/assets/${assetFile.name}`, data);
                        console.log(`Wrote asset file at ${db}/assets/${assetFile.name}`);
                    }
                    catch {
                        console.error(`Failed to write to lightningfs for ${db}/assets/${assetFile.name}`);
                    }
                }

            }

            await printTree(pfs);
        }
        catch (e) {
            console.error(`Failed to find asset dir for ${db}`);
            console.error(e);
        }

    }
}

(window as any).uploadRepos = async (files: File[]) => {
    for (const file of files) {
        await uploadDBZip(file.name.replace(/\.zip$/i, ""), file);
    }
}

const printTree = async (pfs: any, dir: string = "/", prefix: string = ""): Promise<void> => {
    const entries = await pfs.readdir(dir);

    for (let i = 0; i < entries.length; i++) {
        const name = entries[i];
        const isLast = i === entries.length - 1;
        const path = dir === "/" ? `/${name}` : `${dir}/${name}`;

        const stat = await pfs.stat(path);
        const connector = isLast ? "└── " : "├── ";

        console.log(prefix + connector + name);

        if (stat.type === "dir") {
            const newPrefix = prefix + (isLast ? "    " : "│   ");
            await printTree(pfs, path, newPrefix);
        }
    }
}

// --- SPA routing kill-switch ---
// Disables: history.pushState / replaceState, popstate/hashchange listeners,
// and prevents in-page hash changes. Anything trying to navigate should end up
// doing a full reload instead.

(function initRoutingKillSwitch() {
    const KEY = "__routingKillSwitch__";

    function hardNavigate(url) {
        try {
            // If it's an object (like a URL), normalize
            const target = url != null ? String(url) : null;
            if (target) window.location.href = target;
            else window.location.reload();
        } catch {
            window.location.reload();
        }
    }

    window.disableSpaRouting = function disableSpaRouting() {
        // already disabled
        if (window[KEY]?.enabled) return;

        const w = window;
        const hist = w.history;

        // Save originals once
        const saved = w[KEY] || (w[KEY] = {});
        saved.enabled = true;

        saved.history = {
            pushState: hist.pushState,
            replaceState: hist.replaceState,
            back: hist.back,
            forward: hist.forward,
            go: hist.go,
        };

        saved.window = {
            addEventListener: w.addEventListener,
            removeEventListener: w.removeEventListener,
            locationAssign: w.location.assign.bind(w.location),
            locationReplace: w.location.replace.bind(w.location),
        };

        // Track listeners so we can restore them later
        saved.listeners = saved.listeners || [];
        saved.blockedEvents = new Set(["popstate", "hashchange"]);

        // Patch history methods to force full reload navigation
        hist.pushState = function (_state, _title, url) {
            // SPA nav attempt -> hard nav
            hardNavigate(url);
        };
        hist.replaceState = function (_state, _title, url) {
            // SPA replace attempt -> hard nav (or reload if null)
            hardNavigate(url);
        };

        // Optional: stop back/forward/go from doing SPA stuff; make them full reload.
        hist.back = function () {
            // Let the browser go back, then reload to avoid SPA router re-hydrating
            saved.history.back.call(hist);
            // Some browsers won't reload automatically on history traversal
            setTimeout(() => w.location.reload(), 0);
        };
        hist.forward = function () {
            saved.history.forward.call(hist);
            setTimeout(() => w.location.reload(), 0);
        };
        hist.go = function (delta) {
            saved.history.go.call(hist, delta);
            setTimeout(() => w.location.reload(), 0);
        };

        // Block router listeners from being attached + record them for restoration
        w.addEventListener = function (type, listener, options) {
            if (saved.blockedEvents.has(type)) {
                saved.listeners.push({ type, listener, options });
                return; // swallow
            }
            return saved.window.addEventListener.call(w, type, listener, options);
        };

        // Remove works normally (in case app tries cleanup)
        w.removeEventListener = function (type, listener, options) {
            if (saved.blockedEvents.has(type)) {
                // remove from our saved list too
                saved.listeners = saved.listeners.filter(
                    (x) => !(x.type === type && x.listener === listener)
                );
                return;
            }
            return saved.window.removeEventListener.call(w, type, listener, options);
        };

        // Prevent hash-only navigation without reload
        const onHashAttempt = (e) => {
            // If something changed hash, force a reload at the new URL
            // (This still ends in a full page reload, which is what you want.)
            // Using replace to avoid extra history entries:
            e?.preventDefault?.();
            w.location.replace(w.location.href);
        };

        // Keep our own listener (added via the *original* addEventListener)
        saved.killSwitchHandlers = saved.killSwitchHandlers || {};
        saved.killSwitchHandlers.hashchange = onHashAttempt;

        saved.window.addEventListener.call(w, "hashchange", onHashAttempt, true);

        // If a router already attached popstate/hashchange before disable was called,
        // forcing a reload when they trigger keeps you out of SPA transitions.
        const onPopState = (e) => {
            e?.preventDefault?.();
            w.location.reload();
        };
        saved.killSwitchHandlers.popstate = onPopState;
        saved.window.addEventListener.call(w, "popstate", onPopState, true);
    };

    window.restoreSpaRouting = function restoreSpaRouting() {
        const saved = window[KEY];
        if (!saved?.enabled) return;

        const w = window;
        const hist = w.history;

        // Restore history
        if (saved.history) {
            hist.pushState = saved.history.pushState;
            hist.replaceState = saved.history.replaceState;
            hist.back = saved.history.back;
            hist.forward = saved.history.forward;
            hist.go = saved.history.go;
        }

        // Restore add/removeEventListener
        if (saved.window) {
            w.addEventListener = saved.window.addEventListener;
            w.removeEventListener = saved.window.removeEventListener;
        }

        // Remove our kill-switch listeners
        if (saved.killSwitchHandlers?.hashchange) {
            saved.window.removeEventListener.call(
                w,
                "hashchange",
                saved.killSwitchHandlers.hashchange,
                true
            );
        }
        if (saved.killSwitchHandlers?.popstate) {
            saved.window.removeEventListener.call(
                w,
                "popstate",
                saved.killSwitchHandlers.popstate,
                true
            );
        }

        // Re-attach any popstate/hashchange listeners that were blocked while disabled
        if (Array.isArray(saved.listeners) && saved.listeners.length) {
            for (const { type, listener, options } of saved.listeners) {
                saved.window.addEventListener.call(w, type, listener, options);
            }
            saved.listeners = [];
        }

        saved.enabled = false;
    };
})();
