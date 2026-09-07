/**
 * What project a repo binds to when nobody says.
 *
 * `link` used to answer "default" for every repo on every machine, which is wrong in two directions
 * at once. Measured: two unrelated checkouts linked on one account — a storefront and a billing
 * service — both bound to a single project called "Default" and shared one key, so their runs,
 * issues and impact merged into one bucket and the dashboard's per-project view described nothing.
 * It is also what made two TENANTS collide, because a credential slot built from a project id is
 * only as distinct as the ids are.
 *
 * A repo already knows its name: the directory it lives in. That is not a guess, it is the name its
 * owner chose and the one they will look for in a project list.
 */

/** Cap the slug so a deep or oddly-named checkout cannot produce an unreadable project id. */
const MAX_SLUG = 48;

/** The id used when a directory name yields nothing usable — the historical behaviour, unchanged. */
export const DEFAULT_PROJECT_ID = 'default';

/**
 * Turn a directory name into a project id: lowercase, and anything that is not a letter or digit
 * becomes a single hyphen. Conservative on purpose — this id ends up in URLs, in credential slot
 * keys and in a project list somebody has to read.
 */
export const slugifyProjectName = (raw: string): string => {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '');
  return 0 === slug.length ? DEFAULT_PROJECT_ID : slug;
};

/**
 * The project a `link` with no `--project` should target.
 *
 * The EXISTING binding wins over the directory name, and that ordering is the whole safety of this
 * change. A repo that is already linked has history in a project; re-running `link` — which people
 * do to rotate a key or repoint an environment — must land in that same project or the history
 * silently splits in two, which is worse than the shared-bucket problem this fixes.
 */
export const defaultProjectFor = (
  cwdBasename: string,
  existingProjectId: string | undefined,
): string => {
  if (existingProjectId !== undefined && existingProjectId.length > 0) return existingProjectId;
  return slugifyProjectName(cwdBasename);
};
