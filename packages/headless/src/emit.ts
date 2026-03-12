import type { TrajectoryEvent } from "./types";

export const emitEvent = (event: TrajectoryEvent): void => {
  console.log(JSON.stringify(event));
};
