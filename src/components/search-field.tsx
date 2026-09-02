"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/provider";

/**
 * The pill search box each list page opens with, implemented from the mockup.
 * Submitting rewrites `?q=` on the page's own path while keeping whatever else
 * the caller says to keep (the company, the active filter), so filtering stays
 * server-rendered and every state is a shareable URL. The mockup puts one of
 * these on each list rather than a single search in a top bar -- there is no
 * top bar.
 */
export function SearchField({
  basePath,
  params,
  placeholder,
  defaultValue,
  className,
}: {
  basePath: string;
  /** Params to carry over on submit (company, status, ...). */
  params?: Record<string, string | undefined>;
  placeholder: string;
  defaultValue?: string;
  className?: string;
}) {
  const t = useT();
  const router = useRouter();
  const [value, setValue] = useState(defaultValue ?? "");

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const search = new URLSearchParams();
    for (const [key, val] of Object.entries(params ?? {})) {
      if (val) search.set(key, val);
    }
    const trimmed = value.trim();
    if (trimmed) search.set("q", trimmed);
    const query = search.toString();
    router.push(query ? `${basePath}?${query}` : basePath);
  }

  return (
    <form
      onSubmit={submit}
      role="search"
      className={cn(
        "flex h-11 min-w-0 items-center gap-2.5 rounded-full border border-border/70 bg-card px-4.5",
        className,
      )}
    >
      <Search className="size-4 shrink-0 text-muted-foreground" />
      <input
        type="search"
        name="q"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        aria-label={t.common.search}
        className="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-muted-foreground"
      />
    </form>
  );
}
