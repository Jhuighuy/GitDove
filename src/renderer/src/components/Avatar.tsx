import { type AvatarProvider, avatarUrl, providersForRemotes } from "@shared/avatars";
import type { RepoId } from "@shared/domain";
import { memo, useMemo, useState } from "react";
import { hueOf, initials } from "@/lib/format";
import { useRefs } from "@/lib/queries";

/** Avatar URLs known to have no image, so recycled rows don't retry them. */
const missing = new Set<string>();

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
  // Two pixel sizes only, so the cache is shared between the graph and details.
  const url = email.includes("@") ? avatarUrl(email, providers, size > 24 ? 128 : 64) : null;
  const [failed, setFailed] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const showImage = url !== null && failed !== url && !missing.has(url);

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
      {loaded !== url && initials(name)}
      {showImage && (
        <img
          src={url}
          alt=""
          draggable={false}
          decoding="async"
          className="bg-background absolute inset-0 size-full object-cover"
          style={{ opacity: loaded === url ? 1 : 0 }}
          onLoad={() => setLoaded(url)}
          onError={() => {
            missing.add(url);
            setFailed(url);
          }}
        />
      )}
    </span>
  );
});
