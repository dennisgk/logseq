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