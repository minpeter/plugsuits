// Command execution tool
import { runCommandTool } from "./command/run-command";

// File manipulation tools
import { deleteFileTool } from "./file/delete-file";
import { editFileTool } from "./file/edit-file";
import { readFileTool } from "./file/read-file";
import { writeFileTool } from "./file/write-file";

// File search tools
import { globTool } from "./search/glob";
import { grepTool } from "./search/grep";

export const tools = {
  // Command execution
  run_command: runCommandTool,

  // File manipulation
  write_file: writeFileTool,
  edit_file: editFileTool,
  read_file: readFileTool,
  delete_file: deleteFileTool,

  // File search
  glob: globTool,
  grep: grepTool,
} as const;
