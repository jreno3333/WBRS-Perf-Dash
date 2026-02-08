/**
 * Shared weather utilities for fetching and processing weather data
 * from the Open-Meteo API.
 */

// Weather code to condition mapping (unified across all callers)
export function getWeatherCondition(weatherCode: number): string {
  if (weatherCode === 0) return "clear";
  if (weatherCode >= 1 && weatherCode <= 3) return "partly cloudy";
  if (weatherCode >= 45 && weatherCode <= 48) return "foggy";
  if (weatherCode >= 51 && weatherCode <= 57) return "showers";
  if (weatherCode >= 61 && weatherCode <= 67) return "rain";
  if (weatherCode >= 71 && weatherCode <= 77) return "snow";
  if (weatherCode >= 80 && weatherCode <= 82) return "showers";
  if (weatherCode >= 85 && weatherCode <= 86) return "snow";
  if (weatherCode >= 95) return "thunderstorm";
  return "clear";
}

export interface CurrentWeather {
  temp: number;
  condition: string;
  humidity: number;
  windSpeed: number;
}

export interface HistoricalWeather {
  highTemp: number;
  lowTemp: number;
  avgTemp: number;
  condition: string;
}

// Fetch current weather for a location with timeout
export async function fetchWeather(latitude: number, longitude: number): Promise<CurrentWeather | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph`;
    const weatherRes = await fetch(weatherUrl, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (weatherRes.ok) {
      const weatherData = await weatherRes.json();
      const current = weatherData.current;
      return {
        temp: current.temperature_2m,
        condition: getWeatherCondition(current.weather_code),
        humidity: current.relative_humidity_2m,
        windSpeed: current.wind_speed_10m,
      };
    }
  } catch (e) {
    // Silently handle timeout/network errors
  }
  return null;
}

// Fetch historical daily weather (actual high/low for a specific date)
export async function fetchHistoricalWeather(latitude: number, longitude: number, date: string): Promise<HistoricalWeather | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const weatherUrl = `https://archive-api.open-meteo.com/v1/archive?latitude=${latitude}&longitude=${longitude}&start_date=${date}&end_date=${date}&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean,weather_code&temperature_unit=fahrenheit`;
    const weatherRes = await fetch(weatherUrl, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (weatherRes.ok) {
      const weatherData = await weatherRes.json();
      const daily = weatherData.daily;
      if (daily && daily.temperature_2m_max?.[0] !== undefined) {
        return {
          highTemp: daily.temperature_2m_max[0],
          lowTemp: daily.temperature_2m_min[0],
          avgTemp: daily.temperature_2m_mean[0],
          condition: getWeatherCondition(daily.weather_code?.[0] || 0),
        };
      }
    }
  } catch (e) {
    // Silently handle timeout/network errors
  }
  return null;
}
