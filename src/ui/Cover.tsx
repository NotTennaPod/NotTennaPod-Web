// A podcast or episode cover. Android's generated cover (a gradient with the
// title) stands in when there is no image or it fails, as Android's does.
import { useState } from "preact/hooks";

export function Cover({ url, title, size = 56 }: { url: string | null | undefined; title: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const usable = url && /^https:\/\//i.test(url) && !failed;
  if (!usable) {
    return (
      <span class="cover cover-generated" style={{ width: `${size}px`, height: `${size}px` }} aria-hidden="true">
        <span>{title}</span>
      </span>
    );
  }
  return (
    <img
      class="cover"
      src={url}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      referrerpolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
