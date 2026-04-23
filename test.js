import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  stages: [
    { duration: "30s", target: 10 },
    { duration: "1m", target: 10 },
    { duration: "30s", target: 50 },
    { duration: "1m", target: 50 },
    { duration: "30s", target: 0 },
  ],
};

// ----------------------------
// TEST DATA SETS (NEW)
// ----------------------------
const cachedQueries = [
  { name: "mbi scavi", city: "rabat" },
  { name: "auto ecole kaissi baaddi", city: "casablanca" },
];

const randomQueries = [
  { name: "alpha tech maroc", city: "tanger" },
  { name: "xyz non existing company", city: "fes" },
  { name: "fake corp ltd", city: "meknes" },
];

const cityMismatchCases = [
  { name: "somed existing company", city: "rabat" }, // likely mismatch
];

// ----------------------------

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export default function () {
  let payload;

  // ----------------------------
  // 1. MIXED USE CASE SELECTION
  // ----------------------------
  const scenario = Math.random();

  if (scenario < 0.4) {
    // CACHE HIT simulation (same queries repeated)
    payload = pickRandom(cachedQueries);
  } 
  else if (scenario < 0.7) {
    // RANDOM SEARCH (cache miss)
    payload = pickRandom(randomQueries);
  } 
  else {
    // CITY mismatch stress test
    payload = pickRandom(cityMismatchCases);
  }

  const res = http.post(
    "http://localhost:3006/api/search",
    JSON.stringify({
      name: payload.name,
      city: payload.city,
      contextId: null,
    }),
    {
      headers: { "Content-Type": "application/json" },
    }
  );

  check(res, {
    "status is 200 or 503": (r) => r.status === 200 || r.status === 503,
    "response time OK": (r) => r.timings.duration < 5000,
  });

  sleep(0.5);
}