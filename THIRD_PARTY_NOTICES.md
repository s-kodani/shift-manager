# Third-party notices

Apache-2.0 applies to original project material; it does not replace third-party licenses. This initial release distributes source and build instructions, not prebuilt dependency bundles or Container images.

## JavaScript runtime dependencies

| Component | Version | License metadata |
| --- | --- | --- |
| @cloudflare/containers | 0.3.7 | MIT OR Apache-2.0 |
| @radix-ui/react-alert-dialog | 1.2.1 | MIT |
| @radix-ui/react-dialog | 1.3.1 | MIT |
| @radix-ui/react-slot | 1.5.0 | MIT |
| @radix-ui/react-tabs | 1.2.1 | MIT |
| @radix-ui/react-toast | 1.3.1 | MIT |
| better-auth | 1.7.7 | MIT |
| class-variance-authority | 0.7.1 | Apache-2.0 |
| clsx | 2.1.1 | MIT |
| hono | 4.13.16 | MIT |
| lucide-react | 1.57.0 | ISC |
| react | 19.3.0 | MIT |
| react-dom | 19.3.0 | MIT |
| tailwind-merge | 3.7.0 | MIT |
| zod | 4.6.6 | MIT |

License texts available from the installed runtime packages are preserved under licenses/npm/. The complete lock inventory, including development-only LGPL/MPL components, is in [docs/dependency-licenses.json](docs/dependency-licenses.json). Metadata alone is not a license-compliance decision.

## Python dependencies

The optimizer uses OR-Tools, protobuf and jsonschema and their locked dependencies. Available license texts are preserved under licenses/python/; exact versions and reported license metadata are in the inventory. Test tools are not part of the deployed solver API.

## UI and images

React, Radix UI, Lucide, Tailwind and related utilities retain their respective licenses. UI components follow shadcn/ui patterns; its MIT notice is preserved under licenses/shadcn-ui/. The captured legacy reference mock and its bundled code are excluded from this release. The app icon images in this repository are original project assets generated and selected during development; no external font file is distributed.

## Container and build tools

Python, Debian and distroless images and copied OS libraries retain their own licenses. The runtime includes LGPL/GPL-related libraries and Berkeley DB (Sleepycat). Package-level SBOM entries can aggregate licenses from files not actually distributed, so inspect the actual files before classifying obligations. Before distributing a prebuilt image, separately verify notices, complete license texts, corresponding-source availability and any linking/replacement requirements. This source release does not claim that an image redistributor's obligations have been completed.

The Semgrep security-tool environment and development packages have their own licenses; they are downloaded by the developer and are not included as binary distributions here.

## Regeneration

After installing npm dependencies and syncing the optimizer environment, run npm run licenses:inventory. Review changes, missing metadata, copied UI code and actual binary contents; do not automatically approve a license based only on its label.
