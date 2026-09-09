/**
 * Role labeling for model_change entries.
 *
 * omp's ModelChangeEntry.role is authoritative when present:
 *   - undefined  -> the source's own doc comment says "undefined treated as
 *                   default", so we label it "default" rather than guessing.
 *   - "fallback" -> EPHEMERAL_MODEL_CHANGE_ROLE: a retry-fallback swap, not a
 *                   real role. Surfaced as-is since it's genuinely useful info.
 *   - "temporary" -> an explicit `/model` pick made outside the role system
 *                    (not persisted to a role). We try to match it back to a
 *                    configured role's current model via ctx.models.resolve;
 *                    if nothing matches, it's a one-off pick labeled "custom".
 *   - anything else -> a real role name, used verbatim.
 */

export const MODEL_ROLE_IDS = [
	"default",
	"smol",
	"slow",
	"vision",
	"plan",
	"commit",
	"tiny",
	"task",
	"advisor",
] as const;

export interface RoleLabel {
	role: string;
	inferred: boolean;
}

export interface ModelResolver {
	/** Mirrors ExtensionModelQuery.resolve — resolves "@role" or "provider/id" to a Model. */
	resolve(spec: string): { provider: string; id: string } | undefined;
}

export function labelForModelChange(
	entry: { role?: string; model?: string },
	resolver: ModelResolver | undefined,
): RoleLabel {
	const role = entry.role;

	if (role === undefined) return { role: "default", inferred: false };
	if (role === "fallback") return { role: "fallback", inferred: false };

	if (role === "temporary") {
		const modelKey = entry.model;
		if (modelKey && resolver) {
			for (const candidate of MODEL_ROLE_IDS) {
				let resolved: { provider: string; id: string } | undefined;
				try {
					resolved = resolver.resolve(`@${candidate}`);
				} catch {
					resolved = undefined;
				}
				if (resolved && `${resolved.provider}/${resolved.id}` === modelKey) {
					return { role: candidate, inferred: true };
				}
			}
		}
		return { role: "custom", inferred: true };
	}

	return { role, inferred: false };
}
