export interface ViewResetStateIntent {
  kind: "state";
  html: string;
}

export interface ViewResetSetupIntent {
  kind: "setup";
}

export interface ViewResetRestartIntent {
  kind: "restart";
  keepContext?: boolean;
  preserveInput?: boolean;
}

export type ViewResetIntent =
  | ViewResetStateIntent
  | ViewResetSetupIntent
  | ViewResetRestartIntent;
