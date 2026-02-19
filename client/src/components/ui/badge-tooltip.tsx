import * as React from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";

interface BadgeWithTooltipProps {
  /** Badge className (colors, sizing) */
  className?: string;
  /** Badge variant */
  variant?: "default" | "secondary" | "destructive" | "outline";
  /** Content rendered inside the badge */
  children: React.ReactNode;
  /** Tooltip title line */
  tooltipTitle?: string;
  /** Tooltip detail line(s) */
  tooltipDetail?: React.ReactNode;
  /** Full custom tooltip content (overrides title/detail) */
  tooltipContent?: React.ReactNode;
  /** Tooltip placement side */
  side?: "top" | "bottom" | "left" | "right";
  /** data-testid for the badge */
  "data-testid"?: string;
}

/**
 * Badge with a Radix Tooltip — replaces the manual CSS group-hover tooltip pattern.
 * Supports either simple title/detail props or fully custom tooltipContent.
 */
export function BadgeWithTooltip({
  className,
  variant,
  children,
  tooltipTitle,
  tooltipDetail,
  tooltipContent,
  side = "top",
  "data-testid": testId,
}: BadgeWithTooltipProps) {
  const hasTooltip = tooltipContent || tooltipTitle || tooltipDetail;

  // Build native title fallback so description shows even without Radix tooltip
  const nativeTitle = tooltipTitle
    ? `${tooltipTitle}${typeof tooltipDetail === 'string' ? ` — ${tooltipDetail}` : ''}`
    : typeof tooltipDetail === 'string'
      ? tooltipDetail
      : undefined;

  if (!hasTooltip) {
    return (
      <Badge className={className} variant={variant} data-testid={testId}>
        {children}
      </Badge>
    );
  }

  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge className={`cursor-default ${className || ''}`} variant={variant} data-testid={testId} title={nativeTitle}>
            {children}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side={side} className={`text-xs ${tooltipContent ? 'max-w-[320px]' : 'max-w-[280px]'}`}>
          {tooltipContent ? (
            tooltipContent
          ) : (
            <>
              {tooltipTitle && <div className="font-medium">{tooltipTitle}</div>}
              {tooltipDetail && <div className="text-muted-foreground">{tooltipDetail}</div>}
            </>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
