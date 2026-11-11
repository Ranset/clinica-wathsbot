import calendar from "../shared/calendar/tailwind.config.js";

// El mismo tema que el calendario y la web de administracion; solo cambia donde busca clases.
export default {
  ...calendar,
  content: ["./index.html", "./src/**/*.{ts,tsx}", "../shared/calendar/src/**/*.{ts,tsx}"],
};
