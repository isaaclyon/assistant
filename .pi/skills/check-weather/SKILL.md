---
name: check-weather
description: "Checks current weather and short forecasts with the free, keyless Open-Meteo API. Use when the user asks about weather, temperature, conditions, wind, precipitation, or a forecast for a location."
---

# Check Weather

Use Open-Meteo; it is free for non-commercial use and requires no API key.

## Location

If the user gives no location, use **Highland, Utah**. Prefer these saved coordinates when applicable:

| Location | Latitude | Longitude | Time zone |
| --- | ---: | ---: | --- |
| Highland, Utah (home/default) | 40.4272 | -111.7958 | `America/Denver` |
| New York City | 40.7128 | -74.0060 | `America/New_York` |
| Austin, Texas | 30.2672 | -97.7431 | `America/Chicago` |

For another location, first resolve it with:

```text
https://geocoding-api.open-meteo.com/v1/search?name=<URL-ENCODED PLACE>&count=5&language=en&format=json
```

If results are ambiguous, ask the user which place they mean. Never guess between materially different locations.

## Forecast API

Call:

```text
https://api.open-meteo.com/v1/forecast?latitude=<LAT>&longitude=<LON>&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=<TIMEZONE>&forecast_days=<DAYS>
```

Relevant arguments:

- `latitude`, `longitude`: required coordinates.
- `current`: comma-separated current observations.
- `daily`: comma-separated daily forecast fields; requires `timezone`.
- `timezone`: use the saved IANA zone or `auto` for an unfamiliar place.
- `forecast_days`: `1` for current/today; otherwise the requested range, up to 16.
- Unit arguments: present US-friendly °F, mph, and inches. Honor another unit preference if requested.
- `weather_code`: WMO condition code; translate it into plain language using Open-Meteo's documented WMO code table.

Use `curl -fsS` through the available command tool. URL-encode the complete URL or quote it so shell ampersands are not interpreted.

## Response

Report the place and observation time, current temperature, feels-like temperature, plain-language conditions, wind, and precipitation when relevant. Include the daily high/low and precipitation chance when the user asks about today or a forecast. Keep the answer concise and mention that data comes from Open-Meteo.
