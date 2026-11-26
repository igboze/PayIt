// Launch smoke tests (dev only). expo-asset sits nested under expo/ in this install.
module.exports = {
  preset: "jest-expo",
  moduleNameMapper: { "^expo-asset$": "<rootDir>/node_modules/expo/node_modules/expo-asset" },
  testMatch: ["<rootDir>/__tests__/**/*.test.tsx"],
};
