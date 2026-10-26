import Image from "next/image";
import Link from "next/link";

export const REPOSTORY_ICON_PATH = "/repostory-icon.png";
export const REPOSTORY_MARK_PATH = "/repostory-icon-mark.png";

export function RepoStoryBrand({ className = "brand" }: { className?: string }): React.JSX.Element {
  return (
    <Link className={className} href="/" aria-label="RepoStory home">
      <Image className="brand-mark-image" src={REPOSTORY_MARK_PATH} alt="" width={34} height={34} priority />
      <span>RepoStory</span>
    </Link>
  );
}

export function RepoStoryIcon({ alt = "RepoStory", className, size = 84 }: { alt?: string; className?: string; size?: number }): React.JSX.Element {
  return <Image className={className} src={REPOSTORY_MARK_PATH} alt={alt} width={size} height={size} />;
}
