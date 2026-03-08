import { tmpdir } from "node:os";
import { join } from "node:path";

export const CEA_DIR = ".cea";
export const TODO_DIR = join(tmpdir(), "cea-todos");
