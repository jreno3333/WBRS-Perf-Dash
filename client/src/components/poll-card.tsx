import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { motion, AnimatePresence } from "framer-motion";
import { useState } from "react";
import { BarChart3, Check, Vote } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { PollWithResults } from "@shared/schema";
import { usePageVisible } from "@/hooks/use-page-visible";

function PollItem({ poll }: { poll: PollWithResults }) {
  const [selectedOption, setSelectedOption] = useState<string | null>(poll.userVotedOptionId || null);
  const hasVoted = !!poll.userVotedOptionId;

  const voteMutation = useMutation({
    mutationFn: async (optionId: string) => {
      return apiRequest("POST", `/api/polls/${poll.id}/vote`, { optionId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/polls/active"] });
    },
  });

  const handleVote = (optionId: string) => {
    setSelectedOption(optionId);
    voteMutation.mutate(optionId);
  };

  const maxVotes = Math.max(...poll.options.map(o => o.voteCount), 1);

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2">
        <Vote className="w-4 h-4 mt-0.5 text-primary shrink-0" />
        <p className="text-sm font-semibold leading-tight">{poll.question}</p>
      </div>

      <div className="space-y-1.5">
        {poll.options.map(option => {
          const isSelected = selectedOption === option.id || poll.userVotedOptionId === option.id;
          const percentage = poll.totalVotes > 0
            ? Math.round((option.voteCount / poll.totalVotes) * 100)
            : 0;
          const showResults = hasVoted || voteMutation.isSuccess;

          return (
            <button
              key={option.id}
              onClick={() => !showResults && handleVote(option.id)}
              disabled={showResults || voteMutation.isPending}
              className={`
                relative w-full text-left rounded-md border px-3 py-2 text-sm transition-all overflow-hidden
                ${isSelected
                  ? "border-primary bg-primary/5 font-medium"
                  : showResults
                    ? "border-border bg-card"
                    : "border-border hover:border-primary/50 hover:bg-secondary/30 cursor-pointer"
                }
              `}
            >
              {/* Progress bar background */}
              {showResults && (
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${percentage}%` }}
                  transition={{ duration: 0.5, ease: "easeOut" }}
                  className={`absolute inset-y-0 left-0 ${
                    isSelected ? "bg-primary/10" : "bg-muted/50"
                  }`}
                />
              )}

              <div className="relative flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  {isSelected && showResults && (
                    <Check className="w-3.5 h-3.5 text-primary shrink-0" />
                  )}
                  {option.label}
                </span>

                {showResults && (
                  <span className="text-xs text-muted-foreground shrink-0">
                    {percentage}% ({option.voteCount})
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {(hasVoted || voteMutation.isSuccess) && (
        <p className="text-xs text-muted-foreground text-right">
          {poll.totalVotes + (voteMutation.isSuccess && !hasVoted ? 1 : 0)} total votes
        </p>
      )}
    </div>
  );
}

export function PollCard() {
  const isVisible = usePageVisible();
  const { data } = useQuery<{ polls: PollWithResults[] }>({
    queryKey: ["/api/polls/active"],
    refetchInterval: isVisible ? 60 * 1000 : false,
  });

  const activePolls = data?.polls || [];

  if (activePolls.length === 0) return null;

  return (
    <Card className="border-primary/20">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <BarChart3 className="w-4 h-4 text-primary" />
          Quick Poll
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {activePolls.map(poll => (
          <PollItem key={poll.id} poll={poll} />
        ))}
      </CardContent>
    </Card>
  );
}
