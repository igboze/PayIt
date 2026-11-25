const { withAppBuildGradle, withGradleProperties } = require("@expo/config-plugins");

const RELEASE_SIGNING_BLOCK = `    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
        release {
            def signPropsFile = file("\${System.getProperty('user.home')}/.proxim-signing/signing.properties")
            if (signPropsFile.exists()) {
                def props = new Properties()
                signPropsFile.withInputStream { props.load(it) }
                storeFile file(props['storeFile'])
                storePassword props['storePassword']
                keyAlias props['keyAlias']
                keyPassword props['keyPassword']
            } else if (System.getenv('PROXIM_RELEASE_STORE_FILE')) {
                storeFile file(System.getenv('PROXIM_RELEASE_STORE_FILE'))
                storePassword System.getenv('PROXIM_RELEASE_STORE_PASSWORD')
                keyAlias System.getenv('PROXIM_RELEASE_KEY_ALIAS') ?: 'proxim-release'
                keyPassword System.getenv('PROXIM_RELEASE_KEY_PASSWORD')
            }
        }
    }`;

module.exports = function withReleaseSigning(config) {
  config = withAppBuildGradle(config, (mod) => {
    let src = mod.modResults.contents;

    // Replace default debug-only signingConfigs with release-aware signingConfigs
    src = src.replace(
      /    signingConfigs \{\s*debug \{[\s\S]*?\}\s*\}/,
      RELEASE_SIGNING_BLOCK
    );

    // Use release signingConfig ONLY when a real release keystore is configured;
    // otherwise produce app-release-unsigned.apk (never silently sign release builds with debug.keystore).
    src = src.replace(
      /signingConfig signingConfigs\.debug(?=\s*\r?\n\s*def enableShrinkResources)/,
      "if (signingConfigs.release.storeFile != null) { signingConfig signingConfigs.release }"
    );

    mod.modResults.contents = src;
    return mod;
  });

  config = withGradleProperties(config, (mod) => {
    const props = mod.modResults;
    const setProp = (key, value) => {
      const existing = props.find((p) => p.type === "property" && p.key === key);
      if (existing) existing.value = value;
      else props.push({ type: "property", key, value });
    };
    setProp("reactNativeArchitectures", "arm64-v8a,armeabi-v7a");
    return mod;
  });

  return config;
};
