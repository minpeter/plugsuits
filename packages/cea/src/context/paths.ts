import { join } from "node:path";
import { tmpdir } from "node:os";

export const CEA_DIR = ".cea";
export const TODO_DIR = join(tmpdir(), "cea-todos");
