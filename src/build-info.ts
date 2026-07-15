import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const UNKNOWN = 'unknown';

function nonEmptyString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
}

/**
 * Resolve the package version at runtime so source-mode and compiled-mode
 * shells expose the same version without keeping a second constant in sync.
 */
function readPackageVersion(): string {
    try {
        // src/build-info.ts and dist/build-info.js both sit one level below
        // the repository root, where package.json is copied in Docker too.
        const packageFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
        const packageJson = JSON.parse(readFileSync(packageFile, 'utf8')) as { version?: unknown };
        return nonEmptyString(packageJson.version) ?? UNKNOWN;
    } catch {
        return UNKNOWN;
    }
}

/**
 * Release identifiers exposed by /health. Environment values deliberately
 * win so a deploy pipeline can stamp the exact image/source revision.
 */
export function getRelayBuildInfo(environment: NodeJS.ProcessEnv = process.env): Readonly<{ version: string; commit: string }> {
    return Object.freeze({
        version: nonEmptyString(environment.RELAY_VERSION) ?? readPackageVersion(),
        commit: nonEmptyString(environment.RELAY_COMMIT) ?? UNKNOWN,
    });
}
