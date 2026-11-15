// Source-distribution inventory, not a legal conclusion about binary linking.
import {readFile,writeFile,mkdir,readdir,copyFile,lstat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const lock=JSON.parse(await readFile('package-lock.json'));
const npm=[];
for(const [location,p]of Object.entries(lock.packages)){
 if(!location)continue;const name=location.split('node_modules/').at(-1);
 const item={name,version:p.version,license:p.license??'UNKNOWN',scope:p.dev?'development':'runtime',location,licenseFiles:[]};
 if(!p.dev){
  let names=[];try{names=await readdir(location);}catch(e){if(e.code!=='ENOENT')throw e;}
  for(const f of names.filter(n=>/^(?:license|licence|copying|notice)(?:[.-]|$)/i.test(n))){const source=path.join(location,f);if(!(await lstat(source)).isFile())continue;const dest=path.join('licenses/npm',encodeURIComponent(name),f);await mkdir(path.dirname(dest),{recursive:true});await copyFile(source,dest);item.licenseFiles.push(dest);}
 }
 npm.push(item);
}
const python=JSON.parse(execFileSync('services/optimizer/.venv/bin/python',['-c',String.raw`
import importlib.metadata as m,json
from pathlib import Path
rows=[]
for d in sorted(m.distributions(),key=lambda d:d.metadata['Name'].lower()):
    name=d.metadata['Name']; files=[]
    for f in d.files or []:
        if f.name.lower().startswith(('license','licence','copying','notice')):
            source=Path(d.locate_file(f))
            if source.is_file() and source.stat().st_size<1000000:
                dest=Path('licenses/python')/name/f.name
                dest.parent.mkdir(parents=True,exist_ok=True)
                # Preserve distinct texts when a wheel contains repeated names.
                if dest.exists() and dest.read_bytes()!=source.read_bytes():
                    dest=dest.with_name(str(len(files))+'-'+dest.name)
                dest.write_bytes(source.read_bytes());files.append(str(dest))
    rows.append({'name':name,'version':d.version,'license':d.metadata.get('License-Expression') or d.metadata.get('License') or 'UNKNOWN','licenseFiles':files})
print(json.dumps(rows))
`],{encoding:'utf8',maxBuffer:4000000}));
const inventory={schema:'source-dependency-license-inventory-v1',npm:npm.sort((a,b)=>a.name.localeCompare(b.name)||a.version.localeCompare(b.version)),python};
await writeFile('docs/dependency-licenses.json',JSON.stringify(inventory,null,2)+'\n');
const direct=JSON.parse(await readFile('package.json')).dependencies;
const rows=Object.entries(direct).map(([name,version])=>{const p=npm.find(p=>p.name===name&&p.version===version);return `| ${name} | ${version} | ${p?.license??'UNKNOWN'} |`;});
await writeFile('THIRD_PARTY_NOTICES.md',`# Third-party notices\n\nApache-2.0 applies to original project material; it does not replace third-party licenses. This initial release distributes source and build instructions, not prebuilt dependency bundles or Container images.\n\n## JavaScript runtime dependencies\n\n| Component | Version | License metadata |\n| --- | --- | --- |\n${rows.join('\n')}\n\nLicense texts available from the installed runtime packages are preserved under licenses/npm/. The complete lock inventory, including development-only LGPL/MPL components, is in [docs/dependency-licenses.json](docs/dependency-licenses.json). Metadata alone is not a license-compliance decision.\n\n## Python dependencies\n\nThe optimizer uses OR-Tools, protobuf and jsonschema and their locked dependencies. Available license texts are preserved under licenses/python/; exact versions and reported license metadata are in the inventory. Test tools are not part of the deployed solver API.\n\n## UI and images\n\nReact, Radix UI, Lucide, Tailwind and related utilities retain their respective licenses. UI components follow shadcn/ui patterns; its MIT notice is preserved under licenses/shadcn-ui/. The captured legacy reference mock and its bundled code are excluded from this release. The app icon images in this repository are original project assets generated and selected during development; no external font file is distributed.\n\n## Container and build tools\n\nPython, Debian and distroless images and copied OS libraries retain their own licenses. The runtime includes LGPL/GPL-related libraries and Berkeley DB (Sleepycat). Package-level SBOM entries can aggregate licenses from files not actually distributed, so inspect the actual files before classifying obligations. Before distributing a prebuilt image, separately verify notices, complete license texts, corresponding-source availability and any linking/replacement requirements. This source release does not claim that an image redistributor's obligations have been completed.\n\nThe Semgrep security-tool environment and development packages have their own licenses; they are downloaded by the developer and are not included as binary distributions here.\n\n## Regeneration\n\nAfter installing npm dependencies and syncing the optimizer environment, run npm run licenses:inventory. Review changes, missing metadata, copied UI code and actual binary contents; do not automatically approve a license based only on its label.\n`);
console.log(JSON.stringify({npm:npm.length,python:python.length,unknown:npm.filter(p=>p.license==='UNKNOWN').map(p=>p.name)}));
