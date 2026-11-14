// Effects whose callback or dependency list is written in parentheses or
// under a cast.

import { useEffect, useState } from "react";

export function Ticker({
  symbols,
  interval,
}: {
  symbols: string[];
  interval: number;
}) {
  const [quotes, setQuotes] = useState<string[]>([]);

  useEffect(() => {
    setQuotes(symbols.map((symbol) => `${symbol}: loading`));
  }, (symbols));

  useEffect(() => {
    document.title = `every ${interval} ms`;
  }, [interval] as const);

  useEffect((() => {
    setQuotes([]);
  }), []);

  return (
    <ul>
      {quotes.map((quote) => (
        <li key={quote}>{quote}</li>
      ))}
    </ul>
  );
}
