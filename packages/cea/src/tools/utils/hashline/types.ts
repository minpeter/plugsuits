export interface ReplaceEdit {
  end?: string;
  lines: string | string[];
  op: "replace";
  pos: string;
}

export interface AppendEdit {
  lines: string | string[];
  op: "append";
  pos?: string;
}

export interface PrependEdit {
  lines: string | string[];
  op: "prepend";
  pos?: string;
}

export type HashlineEdit = ReplaceEdit | AppendEdit | PrependEdit;
