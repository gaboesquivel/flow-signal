/** The Crewday simulation's public API (spec 004, task 03); task 04 wraps it in a CLI. */
export { createBoardAi, keywordRank } from "./board-ai";
export { metricsWindowsFor, runArm } from "./engine";
export type { MetricsSnapshot, RunArmOptions, RunResult, RunSnapshot } from "./engine";
export { createOfflineSignalAi } from "./offline-ai";
export { createOracleEmbedder, ORACLE_EMBEDDING_MODEL } from "./oracle";
export type { OracleEmbedder } from "./oracle";
export { defaultPolicy, resolvePolicy } from "./policy";
export type { PolicyParams } from "./policy";
export { assertSimDatabase, UnsafeDatabaseError } from "./safety";
export type { SimDatabaseTarget } from "./safety";
export type { Arm } from "./state";
