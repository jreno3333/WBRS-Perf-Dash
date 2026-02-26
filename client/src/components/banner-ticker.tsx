import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect, useRef, useCallback } from "react";
import { Megaphone, Trophy, Zap, Star } from "lucide-react";
import type { TickerMessage } from "@shared/schema";

const priorityConfig = {
  urgent: { icon: Zap, bgClass: "bg-red-500/10 border-red-500/30", textClass: "text-red-400", iconClass: "text-red-400" },
  high: { icon: Trophy, bgClass: "bg-amber-500/10 border-amber-500/30", textClass: "text-amber-300", iconClass: "text-amber-400" },
  normal: { icon: Megaphone, bgClass: "bg-primary/5 border-primary/20", textClass: "text-foreground", iconClass: "text-primary" },
};

const typeIcons: Record<string, typeof Star> = {
  milestone: Star,
  immediate: Megaphone,
  scheduled: Megaphone,
};

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
      // ~50px per second scroll speed
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

export function BannerTicker() {
  const { data } = useQuery<{ messages: TickerMessage[] }>({
    queryKey: ["/api/ticker/messages"],
    refetchInterval: 30 * 1000, // Refresh every 30 seconds
  });

  const messages = data?.messages || [];
  const [currentIndex, setCurrentIndex] = useState(0);

  // Cycle through messages
  useEffect(() => {
    if (messages.length <= 1) return;
    const interval = setInterval(() => {
      setCurrentIndex(prev => (prev + 1) % messages.length);
    }, 6000); // 6 seconds per message
    return () => clearInterval(interval);
  }, [messages.length]);

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
  const TypeIcon = typeIcons[current.type] || Megaphone;
  const PrioIcon = prio.icon;

  return (
    <div className={`relative overflow-hidden rounded-lg border ${prio.bgClass} px-4 py-2`}>
      <div className="flex items-center gap-3">
        {/* Icon */}
        <div className={`shrink-0 ${prio.iconClass}`}>
          {current.type === "milestone" ? (
            <Star className="w-4 h-4" />
          ) : (
            <PrioIcon className="w-4 h-4" />
          )}
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

        {/* Message counter */}
        {messages.length > 1 && (
          <div className="shrink-0 flex items-center gap-1.5">
            {messages.map((_, idx) => (
              <button
                key={idx}
                onClick={() => setCurrentIndex(idx)}
                className={`w-1.5 h-1.5 rounded-full transition-all ${
                  idx === currentIndex
                    ? "bg-primary w-4"
                    : "bg-muted-foreground/30 hover:bg-muted-foreground/50"
                }`}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
