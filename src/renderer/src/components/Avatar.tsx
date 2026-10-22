import { type AvatarProvider, avatarUrl, providersForRemotes } from "@shared/avatars";
import type { RepoId } from "@shared/domain";
import { memo, useMemo, useState } from "react";
import { hueOf, initials } from "@/lib/format";
import { useRefs } from "@/lib/queries";

/**
 * Avatar URLs that failed to load, and when, so that recycled rows don't retry them at once.
 * They are retried after a while: the failure may have been passing (e.g. offline).
 */
const missing = new Map<string, number>();
export const MISSING_RETRY_MS = 10 * 60 * 1000;

/**
 * The one picture size asked for, so that each avatar is fetched and cached once: sharp up to
 * 32 px on a 2x display (the largest avatar shown is 28 px).
 */
export const AVATAR_PX = 64;

const isMissing = (url: string) => {
  const since = missing.get(url);
  if (since === undefined) return false;
  if (Date.now() - since < MISSING_RETRY_MS) return true;
  missing.delete(url);
  return false;
};

/** Avatar providers for a repository, derived from its remotes (stable identity). */
export const useAvatarProviders = (repo: RepoId): readonly AvatarProvider[] => {
  const { data } = useRefs(repo);
  const key = providersForRemotes((data?.remotes ?? []).map((r) => r.fetchUrl)).join(",");
  return useMemo(() => (key ? (key.split(",") as AvatarProvider[]) : []), [key]);
};

interface Props {
  readonly name: string;
  readonly email: string;
  readonly providers: readonly AvatarProvider[];
  readonly size?: number;
}

/**
 * Author avatar: colored initials, covered by the real picture (GitHub, GitLab
 * or Gravatar, resolved and cached by the main process) once it has loaded.
 */
export const Avatar = memo(function Avatar({ name, email, providers, size = 18 }: Props) {
  const url = email.includes("@") ? avatarUrl(email, providers, AVATAR_PX) : null;
  const [failed, setFailed] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const showImage = url !== null && failed !== url && !isMissing(url);

  return (
    <span
      className="relative flex shrink-0 items-center justify-center overflow-hidden rounded-full font-bold text-white select-none"
      style={{
        width: size,
        height: size,
        backgroundColor: `oklch(0.55 0.12 ${hueOf(email || name)})`,
        fontSize: size * 0.42,
      }}
      title={`${name} <${email}>`}
    >
      {(url === null || loaded !== url) && initials(name)}
      {showImage && (
        <img
          src={url}
          alt=""
          draggable={false}
          decoding="async"
          loading="lazy"
          className="bg-background absolute inset-0 size-full object-cover"
          style={{ opacity: loaded === url ? 1 : 0 }}
          onLoad={() => setLoaded(url)}
          onError={() => {
            missing.set(url, Date.now());
            setFailed(url);
          }}
        />
      )}
    </span>
  );
});
