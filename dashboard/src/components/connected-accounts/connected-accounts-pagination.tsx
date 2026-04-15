"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

interface ConnectedAccountsPaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

function buildPageNumbers(page: number, totalPages: number) {
  const start = Math.max(1, page - 2);
  const end = Math.min(totalPages, start + 4);
  const normalizedStart = Math.max(1, end - 4);

  return Array.from({ length: end - normalizedStart + 1 }, (_, index) => normalizedStart + index);
}

export function ConnectedAccountsPagination({
  page,
  totalPages,
  onPageChange,
}: ConnectedAccountsPaginationProps) {
  const t = useTranslations("usage");

  if (totalPages <= 1) {
    return null;
  }

  const pages = buildPageNumbers(page, totalPages);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="text-xs text-[var(--text-muted)]">{t("pageOf", { page, total: totalPages })}</div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          className="px-2.5 py-1 text-xs"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          {t("previous")}
        </Button>

        {pages.map((pageNumber) => (
          <Button
            key={pageNumber}
            variant={pageNumber === page ? "primary" : "secondary"}
            className="px-2.5 py-1 text-xs"
            onClick={() => onPageChange(pageNumber)}
          >
            {pageNumber}
          </Button>
        ))}

        <Button
          variant="secondary"
          className="px-2.5 py-1 text-xs"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          {t("next")}
        </Button>
      </div>
    </div>
  );
}
