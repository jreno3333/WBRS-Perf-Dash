import type { ReactNode } from "react";
import { NavBar } from "@/components/nav-bar";

interface PageHeaderProps {
  /** Page title text */
  title: string;
  /** Optional icon element displayed before the title */
  icon?: ReactNode;
  /** Optional content rendered between title and NavBar (e.g. date controls, filters) */
  children?: ReactNode;
}

/**
 * Consistent sticky header used across all pages.
 * Provides standard layout: icon + title on left, NavBar on right,
 * with optional children (filters, date pickers) in between.
 */
export function PageHeader({ title, icon, children }: PageHeaderProps) {
  return (
    <header className="sticky top-0 z-50 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-b">
      <div className="container mx-auto px-3 sm:px-6">
        <div className="flex items-center justify-between h-12 sm:h-14 gap-2 flex-wrap">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 shrink">
            {icon && (
              <div className="bg-primary/10 p-1.5 rounded-lg shrink-0">
                {icon}
              </div>
            )}
            <h1 className="text-sm sm:text-base font-semibold tracking-tight whitespace-nowrap">
              {title}
            </h1>
          </div>

          <div className="flex items-center gap-2">
            {children}
            <NavBar />
          </div>
        </div>
      </div>
    </header>
  );
}
