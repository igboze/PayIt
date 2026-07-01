const fs = require("fs");
const path = require("path");
const solc = require("solc");

const contractFile = path.join(__dirname, "..", "contracts", "InvoiceSettlement.sol");
const artifactDir = path.join(__dirname, "..", "artifacts");
const artifactFile = path.join(artifactDir, "InvoiceSettlement.json");

function findImports(importPath) {
  const fullPath = path.join(path.dirname(contractFile), importPath);
  if (fs.existsSync(fullPath)) {
    return { contents: fs.readFileSync(fullPath, "utf8") };
  }
  return { error: `File not found: ${importPath}` };
}

function compile() {
  const source = fs.readFileSync(contractFile, "utf8");
  const input = {
    language: "Solidity",
    sources: {
      "InvoiceSettlement.sol": {
        content: source,
      },
    },
    settings: {
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "metadata"],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

  if (output.errors) {
    const errors = output.errors.filter((e) => e.severity === "error");
    const warnings = output.errors.filter((e) => e.severity === "warning");

    warnings.forEach((warning) => console.warn(warning.formattedMessage || warning.message));
    if (errors.length > 0) {
      errors.forEach((error) => console.error(error.formattedMessage || error.message));
      throw new Error("Solidity compilation failed with errors.");
    }
  }

  const contractOutput = output.contracts["InvoiceSettlement.sol"]?.InvoiceSettlement;
  if (!contractOutput) {
    throw new Error("Compiled contract output not found.");
  }

  const artifact = {
    abi: contractOutput.abi,
    bytecode: contractOutput.evm.bytecode.object,
    deployedBytecode: contractOutput.evm.deployedBytecode.object,
    metadata: JSON.parse(contractOutput.metadata),
  };

  if (!fs.existsSync(artifactDir)) {
    fs.mkdirSync(artifactDir, { recursive: true });
  }
  fs.writeFileSync(artifactFile, JSON.stringify(artifact, null, 2));
  console.log(`Compiled InvoiceSettlement.sol -> ${artifactFile}`);
}

function main() {
  compile();
}

main();
