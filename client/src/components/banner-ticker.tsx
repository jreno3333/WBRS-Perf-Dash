import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect, useRef, useCallback } from "react";
import { Megaphone, Trophy, Zap, Star, X, ChevronDown } from "lucide-react";
import type { TickerMessage } from "@shared/schema";

const priorityConfig = {
  urgent: { icon: Zap, bgClass: "bg-red-500/10 border-red-500/30", textClass: "text-red-400", iconClass: "text-red-400" },
  high: { icon: Trophy, bgClass: "bg-amber-500/10 border-amber-500/30", textClass: "text-amber-300", iconClass: "text-amber-400" },
  normal: { icon: Megaphone, bgClass: "bg-primary/5 border-primary/20", textClass: "text-foreground", iconClass: "text-primary" },
};

function getIcon(msg: TickerMessage) {
  if (msg.type === "milestone") return Star;
  const prio = priorityConfig[msg.priority as keyof typeof priorityConfig] || priorityConfig.normal;
  return prio.icon;
}

/** Scrolls text horizontally when it overflows its container */
function MarqueeText({ text, className }: { text: string; className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [shouldScroll, setShouldScroll] = useState(false);
  const [duration, setDuration] = useState(10);

  const measure = useCallback(() => {
    const container = containerRef.current;
    const span = textRef.current;
    if (!container || !span) return;
    const overflow = span.scrollWidth > container.clientWidth + 2;
    setShouldScroll(overflow);
    if (overflow) {
      setDuration(Math.max(5, span.scrollWidth / 50));
    }
  }, []);

  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [text, measure]);

  return (
    <div ref={containerRef} className="overflow-hidden whitespace-nowrap">
      <span
        ref={textRef}
        className={`${className} inline-block ${shouldScroll ? "animate-marquee" : ""}`}
        style={shouldScroll ? { animationDuration: `${duration}s` } : undefined}
      >
        {text}
        {shouldScroll && (
          <>
            <span className="mx-12" aria-hidden="true">•</span>
            <span aria-hidden="true">{text}</span>
          </>
        )}
      </span>
    </div>
  );
}

/** Expanded view showing ALL messages in a scrollable list */
function AllMessages({ messages, onClose }: { messages: TickerMessage[]; onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.25, ease: "easeInOut" }}
      className="rounded-lg border border-border bg-card overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <span className="text-xs font-medium text-muted-foreground">
          {messages.length} message{messages.length !== 1 ? "s" : ""}
        </span>
        <button
          onClick={onClose}
          className="p-1 rounded-md hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Scrollable message list */}
      <div className="max-h-60 overflow-y-auto divide-y divide-border">
        {messages.map((msg) => {
          const prio = priorityConfig[msg.priority as keyof typeof priorityConfig] || priorityConfig.normal;
          const Icon = getIcon(msg);
          return (
            <div key={msg.id} className={`flex items-start gap-3 px-4 py-2.5 ${prio.bgClass.replace("border-", "")}`}>
              <div className={`shrink-0 mt-0.5 ${prio.iconClass}`}>
                <Icon className="w-4 h-4" />
              </div>
              <p className={`text-sm font-medium ${prio.textClass} whitespace-normal break-words`}>
                {msg.message}
              </p>
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}

export function BannerTicker() {
  const { data } = useQuery<{ messages: TickerMessage[] }>({
    queryKey: ["/api/ticker/messages"],
    refetchInterval: 30 * 1000,
  });

  const messages = data?.messages || [];
  const [currentIndex, setCurrentIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);

  // Cycle through messages — paused while expanded
  useEffect(() => {
    if (messages.length <= 1 || expanded) return;
    const interval = setInterval(() => {
      setCurrentIndex(prev => (prev + 1) % messages.length);
    }, 10000);
    return () => clearInterval(interval);
  }, [messages.length, expanded]);

  // Reset index if messages change
  useEffect(() => {
    if (currentIndex >= messages.length) {
      setCurrentIndex(0);
    }
  }, [messages.length, currentIndex]);

  if (messages.length === 0) return null;

  const current = messages[currentIndex];
  if (!current) return null;

  const prio = priorityConfig[current.priority as keyof typeof priorityConfig] || priorityConfig.normal;
  const PrioIcon = getIcon(current);

  return (
    <AnimatePresence mode="wait">
      {expanded ? (
        <AllMessages
          key="all-messages"
          messages={messages}
          onClose={() => setExpanded(false)}
        />
      ) : (
        <motion.div
          key="ticker"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className={`relative overflow-hidden rounded-lg border ${prio.bgClass} px-4 py-2 cursor-pointer`}
          onClick={() => setExpanded(true)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setExpanded(true); }}
        >
          <div className="flex items-center gap-3">
            {/* Icon */}
            <div className={`shrink-0 ${prio.iconClass}`}>
              <PrioIcon className="w-4 h-4" />
            </div>

            {/* Scrolling message area */}
            <div className="flex-1 overflow-hidden relative min-h-[1.5rem]">
              <AnimatePresence mode="wait">
                <motion.div
                  key={current.id}
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: -20, opacity: 0 }}
                  transition={{ duration: 0.4, ease: "easeInOut" }}
                >
                  <MarqueeText text={current.message} className={`text-sm font-medium ${prio.textClass}`} />
                </motion.div>
              </AnimatePresence>
            </div>

            {/* Expand hint + counter */}
            {messages.length > 1 && (
              <div className="shrink-0 flex items-center gap-1 text-muted-foreground">
                <span className="text-xs">{currentIndex + 1}/{messages.length}</span>
                <ChevronDown className="w-3.5 h-3.5" />
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
