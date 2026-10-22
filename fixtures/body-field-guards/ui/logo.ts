// Two callers of the favicon route. Neither reads the status. The first
// writes an `else` for a body without `exists`, so a 400 or a 500 lands
// there. The second writes nothing for that case.

export function suggestLogo(
  domain: string,
  setLogo: (url: string) => void,
): void {
  fetch(`/api/favicon?domain=${domain}`)
    .then((response) => response.json())
    .then((data) => {
      if (data.exists) {
        setLogo(data.url);
      } else {
        console.log("No favicon for", domain, data.status);
      }
    });
}

export async function prefetchLogo(
  domain: string,
  setLogo: (url: string) => void,
): Promise<void> {
  const response = await fetch(`/api/favicon?domain=${domain}`);
  const data = await response.json();
  if (data.exists) {
    setLogo(data.url);
  }
}
