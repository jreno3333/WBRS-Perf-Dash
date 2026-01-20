import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { ArrowLeft, Save, Target, Building2 } from "lucide-react";
import { Link } from "wouter";
import type { Restaurant } from "@shared/schema";

export default function Settings() {
  const { toast } = useToast();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>("");

  const { data: restaurants, isLoading } = useQuery<Restaurant[]>({
    queryKey: ["/api/restaurants"],
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, laborTarget }: { id: string; laborTarget: number }) => {
      const response = await apiRequest("PATCH", `/api/restaurants/${id}/labor-target`, { laborTarget });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/restaurants"] });
      queryClient.invalidateQueries({ queryKey: ["/api/leaderboard"] });
      toast({
        title: "Labor target updated",
        description: "The labor target has been saved successfully.",
      });
      setEditingId(null);
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: "Failed to update labor target. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleEdit = (restaurant: Restaurant) => {
    setEditingId(restaurant.id);
    setEditValue(restaurant.laborTarget || "25");
  };

  const handleSave = (id: string) => {
    const value = parseFloat(editValue);
    if (isNaN(value) || value < 0 || value > 100) {
      toast({
        title: "Invalid value",
        description: "Labor target must be between 0 and 100.",
        variant: "destructive",
      });
      return;
    }
    updateMutation.mutate({ id, laborTarget: value });
  };

  const handleCancel = () => {
    setEditingId(null);
    setEditValue("");
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center gap-4">
            <Link href="/">
              <Button variant="ghost" size="icon" data-testid="button-back">
                <ArrowLeft className="w-5 h-5" />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold text-primary">Settings</h1>
              <p className="text-sm text-muted-foreground">Manage restaurant labor targets</p>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Target className="w-5 h-5" />
              Labor Targets by Restaurant
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-center py-8 text-muted-foreground">Loading restaurants...</div>
            ) : (
              <div className="space-y-2">
                {restaurants?.map((restaurant) => (
                  <div
                    key={restaurant.id}
                    className="flex items-center justify-between p-3 rounded-lg border bg-card hover-elevate"
                    data-testid={`row-restaurant-${restaurant.id}`}
                  >
                    <div className="flex items-center gap-3">
                      <Building2 className="w-4 h-4 text-muted-foreground" />
                      <span className="font-medium">{restaurant.name}</span>
                      <Badge variant="outline" className="text-xs">
                        {restaurant.timezone?.includes("New_York") ? "ET" : "CT"}
                      </Badge>
                    </div>
                    
                    <div className="flex items-center gap-2">
                      {editingId === restaurant.id ? (
                        <>
                          <Input
                            type="number"
                            min="0"
                            max="100"
                            step="0.5"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            className="w-20 h-8"
                            data-testid={`input-labor-target-${restaurant.id}`}
                          />
                          <span className="text-sm text-muted-foreground">%</span>
                          <Button
                            size="sm"
                            onClick={() => handleSave(restaurant.id)}
                            disabled={updateMutation.isPending}
                            data-testid={`button-save-${restaurant.id}`}
                          >
                            <Save className="w-4 h-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={handleCancel}
                            data-testid={`button-cancel-${restaurant.id}`}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <>
                          <span className="text-lg font-semibold text-primary">
                            {restaurant.laborTarget || "25"}%
                          </span>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleEdit(restaurant)}
                            data-testid={`button-edit-${restaurant.id}`}
                          >
                            Edit
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
