import { join } from "node:path";
import { homedir } from "node:os";

const BASE = join(homedir(), ".collaborator");

export const COLLAB_DIR = import.meta.env?.DEV ? join(BASE, "dev") : BASE;
