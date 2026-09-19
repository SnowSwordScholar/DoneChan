/**
 * Type surface for DoneChan's DSH plugin.
 *
 * The plugin itself is plain JavaScript with no dependencies, so nothing about
 * it needs building; this file exists only so TypeScript consumers (the test
 * suite) see a typed module instead of an implicit `any`.
 */

/** The slice of a Cordis context the plugin touches. */
export interface DonechanPluginContext {
  /** Register a listener on a harness extension point. */
  on(event: string, handler: (...args: any[]) => unknown): void;
  logger: { warn(message: string): void };
}

/** Plugin config, as written into the profile patch by `donechan install dsh`. */
export interface DonechanPluginConfig {
  /** Absolute path of the installed `donechan` CLI entry (`dist/cli.js`). */
  cliPath?: string;
}

export declare const name: "donechan";

/**
 * Register the two notification listeners. Logs a warning and registers nothing
 * when `cliPath` is missing, so a bad config never breaks DSH boot.
 */
export declare function apply(ctx: DonechanPluginContext, config: DonechanPluginConfig): void;
