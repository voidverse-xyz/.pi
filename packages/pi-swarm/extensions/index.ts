import { createCurrentSwarmExtension } from "./swarm/extension.mjs";

// Explicit `pi -e` entry; no host, auth lookup, or execution during registration.
export default createCurrentSwarmExtension();
