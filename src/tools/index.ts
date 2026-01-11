import { shellExecuteTool } from "./execute/shell-execute";
import { shellInteractTool } from "./execute/shell-interact";
import { globTool } from "./explore/glob";
import { grepTool } from "./explore/grep";
import { readFileTool } from "./explore/read-file";
import { deleteFileTool } from "./modify/delete-file";
import { editFileTool } from "./modify/edit-file";
import { writeFileTool } from "./modify/write-file";
import { loadSkillTool } from "./planning/load-skill";
import { todoWriteTool } from "./planning/todo-write";

export const tools = {
  shell_execute: shellExecuteTool,
  shell_interact: shellInteractTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  read_file: readFileTool,
  delete_file: deleteFileTool,
  glob: globTool,
  grep: grepTool,
  load_skill: loadSkillTool,
  todo_write: todoWriteTool,
} as const;
