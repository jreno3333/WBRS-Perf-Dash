import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatLongDate } from "@/lib/dates";

interface DateNavigatorProps {
  selectedDate: Date;
  isToday: boolean;
  onPreviousDay: () => void;
  onNextDay: () => void;
  onSelectDate: (date: Date) => void;
  onGoToToday: () => void;
}

export function DateNavigator({
  selectedDate,
  isToday,
  onPreviousDay,
  onNextDay,
  onSelectDate,
  onGoToToday,
}: DateNavigatorProps) {
  return (
    <>
      {/* Desktop date nav */}
      <div className="hidden sm:flex items-center gap-0.5 text-sm">
        <button
          className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
          onClick={onPreviousDay}
          data-testid="button-prev-day"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <Popover>
          <PopoverTrigger asChild>
            <button
              className="px-2 py-1 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
              data-testid="button-date-picker"
            >
              {formatLongDate(selectedDate)}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              selected={selectedDate}
              onSelect={(date) => date && onSelectDate(date)}
              disabled={(date) => date > new Date()}
              initialFocus
            />
          </PopoverContent>
        </Popover>
        <button
          className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30"
          onClick={onNextDay}
          disabled={isToday}
          data-testid="button-next-day"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
        {!isToday && (
          <button
            className="ml-1 px-2 py-0.5 rounded-md text-xs font-medium text-primary hover:bg-primary/10 transition-colors"
            onClick={onGoToToday}
            data-testid="button-go-today"
          >
            Today
          </button>
        )}
      </div>

      {/* Mobile date nav */}
      <div className="sm:hidden flex items-center justify-center gap-1 pb-2 -mt-1">
        <button
          className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
          onClick={onPreviousDay}
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <Popover>
          <PopoverTrigger asChild>
            <button className="px-2 py-1 rounded-md text-sm text-muted-foreground hover:text-foreground">
              {formatLongDate(selectedDate)}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="center">
            <Calendar
              mode="single"
              selected={selectedDate}
              onSelect={(date) => date && onSelectDate(date)}
              disabled={(date) => date > new Date()}
              initialFocus
            />
          </PopoverContent>
        </Popover>
        <button
          className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30"
          onClick={onNextDay}
          disabled={isToday}
        >
          <ChevronRight className="w-4 h-4" />
        </button>
        {!isToday && (
          <button
            className="ml-1 px-2 py-0.5 rounded-md text-xs font-medium text-primary"
            onClick={onGoToToday}
          >
            Today
          </button>
        )}
      </div>
    </>
  );
}
