import { useQuery } from "@tanstack/react-query";

interface DriveThruData {
  carCount: number;
  avgTotalTime: number;
  avgServiceTime: number;
  speedAttainment: number;
}

interface Restaurant {
  restaurantId: string;
  restaurantName: string;
  driveThru?: DriveThruData;
}

interface LeaderboardResponse {
  restaurants: Restaurant[];
}

export default function HMETest() {
  const { data, isLoading, error } = useQuery<LeaderboardResponse>({
    queryKey: ["/api/leaderboard"],
  });

  if (isLoading) return <div className="p-8">Loading...</div>;
  if (error) return <div className="p-8 text-red-500">Error: {String(error)}</div>;

  const restaurants = data?.restaurants || [];
  const withDriveThru = restaurants.filter(r => r.driveThru);

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-4">HME Drive-Thru Test Page</h1>
      <p className="mb-4">
        Total restaurants: {restaurants.length} | 
        With drive-thru data: {withDriveThru.length}
      </p>
      
      <div className="space-y-2">
        {restaurants.map(r => (
          <div key={r.restaurantId} className="p-3 border rounded">
            <div className="font-medium">{r.restaurantName}</div>
            {r.driveThru ? (
              <div className="text-green-600">
                DT Time: {Math.floor(r.driveThru.avgTotalTime / 60)}:{(r.driveThru.avgTotalTime % 60).toString().padStart(2, '0')} | 
                Cars: {r.driveThru.carCount} | 
                Speed Attainment: {r.driveThru.speedAttainment}%
              </div>
            ) : (
              <div className="text-gray-400">No drive-thru data</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
