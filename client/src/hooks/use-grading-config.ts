import { useQuery } from "@tanstack/react-query";
import type { GradingConfigData } from "@shared/grading-config";
import { DEFAULT_GRADING_CONFIG } from "@shared/grading-config";

/**
 * Shared hook to fetch the active grading configuration.
 * Returns DEFAULT_GRADING_CONFIG while loading or on error.
 */
export function useGradingConfig(): GradingConfigData {
  const { data } = useQuery<GradingConfigData>({
    queryKey: ["/api/grading-config"],
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
  return data || DEFAULT_GRADING_CONFIG;
}
