// Shared in-memory runtime state.
//
// `preparing` holds the ids of servers currently being prepared (unzip/build).
// While an id is in this set, status pollers must not overwrite its status with
// a Docker inspect result, since the container may not exist yet.
export const preparing = new Set<string>();
