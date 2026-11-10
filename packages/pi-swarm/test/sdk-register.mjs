// Require the managed installation contract, then reuse the repository SDK aliases.
import { resolvePiPackageDir } from './pi-install.mjs';
process.env.PI_SDK_DIR = resolvePiPackageDir();
await import('../../../tests/register.mjs');
