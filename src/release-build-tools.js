const childProcess = require('child_process');
const {tmpdir} = require("os");
const repo = require("./repository");
const {accessSync, constants} = require("fs");
const fs = require("fs/promises");
const path = require("path");
const {readComposerJson, createMagentoCommunityEditionMetapackage,
  createPackagesForRef,
  createPackageForRef,
  createMetaPackageFromRepoDir,
  createMagentoCommunityEditionProject
} = require('./package-modules');
const repositoryBuildDefinition = require('./type/repository-build-definition');
const packageDefinition = require('./type/package-definition');


function fsExists(dirOrFile) {
  try {
    accessSync(dirOrFile, constants.R_OK);
    return true;
  } catch (exception) {
    return false;
  }
}


async function composerCreateMagentoProject(version) {
  console.log(`Determining upstream package versions for release ${version}...`);
  const workDir = `${tmpdir()}/workdir-${version}`;
  return new Promise((resolve, reject) => {
    if (fsExists(workDir)) {
      console.log(`Found existing installation at ${workDir}`)
      resolve(workDir)
    } else {
      const command = `composer create-project --ignore-platform-reqs --repository-url https://mirror.mage-os.org magento/project-community-edition ${workDir} ${version}`
      console.log(`Running ${command}`)
      const bufferBytes = 4 * 1024 * 1024; // 4M
      childProcess.exec(command, {maxBuffer: bufferBytes}, (error, stdout, stderr) => {
        //if (stderr && stderr.includes('Warning: The lock file is not up-to-date with the latest changes in composer.json')) stderr = '';
        if (stderr && stderr.includes('Generating autoload files')) stderr = '';
        if (error) {
          reject(`Error executing command: ${error.message}`)
        }
        if (stderr) {
          reject(`[error] ${stderr}`)
        }
        resolve(workDir)
      })
    }
  })
}

async function installSampleData(dir) {
  // @see \Magento\SampleData\Model\Dependency::SAMPLE_DATA_SUGGEST
  const SAMPLE_DATA_SUGGEST = 'Sample Data version:';
  const listCommand = `composer suggests --all`
  const bufferBytes = 4 * 1024 * 1024; // 4M
  const output = await (new Promise((resolve, reject) => {
    childProcess.exec(listCommand, {maxBuffer: bufferBytes, cwd: dir}, (error, stdout, stderr) => {
      if (error) {
        reject(`Error executing command: ${error.message}`)
      }
      if (stderr) {
        reject(`[error] ${stderr}`)
      }
      resolve(stdout.trim())
    })
  }))
  const packages = output.split("\n").filter(line => line.includes(SAMPLE_DATA_SUGGEST)).map(line => {
    // A line looks like (without the quotes):
    // " - magento/module-bundle-sample-data: Sample Data version: 100.4.*"
    const re = new RegExp(`^.+(?<package>magento\\/[^:]+): ${SAMPLE_DATA_SUGGEST}.*?(?<version>\\d.*)$`)
    return line.replace(re, '$<package>:$<version>')
  })
  return packages.length === 0
    ? true
    : new Promise((resolve, reject) => {
      const installCommand = `composer require --ignore-platform-reqs "${packages.join('" "')}"`
      console.log(`Installing sample data packages`)
      childProcess.exec(installCommand, {maxBuffer: bufferBytes, cwd: dir}, (error, stdout, stderr) => {
        if (stderr && stderr.includes('Generating autoload files')) stderr = '';
        if (error) {
          reject(`Error executing command: ${error.message}`)
        }
        if (stderr) {
          reject(`[error] ${stderr}`)
        }
        resolve(true)
      })
    })
}

async function getInstalledPackageMap(dir) {
  const command = `composer show --format=json`
  const bufferBytes = 4 * 1024 * 1024; // 4M
  const output = await (new Promise((resolve, reject) => {
    childProcess.exec(command, {maxBuffer: bufferBytes, cwd: dir}, (error, stdout, stderr) => {
      if (error) {
        reject(`Error executing command: ${error.message}`)
      }
      if (stderr) {
        reject(`[error] ${stderr}`)
      }
      resolve(stdout)
    })
  }))
  return JSON.parse(output).installed.reduce((map, installedPackage) => {
    map[installedPackage.name] = installedPackage.version
    return map;
  })
}

function validateVersionString(version, name) {
  const options = [
    /^[0-9]+\.[0-9]+(-[a-z][a-z0-9.]*)?$/, // e.g, 1.0, 1.2-beta, 2.4-p2
    /^[0-9]+\.[0-9]+\.[0-9]+(-[a-z][a-z0-9.]*)?$/ // e.g. 1.0.0, 1.2.1-alpha, 1.2.2-patch2
  ]
  if (options.map(re => version.match(re)).filter(v => v !== null).length === 0) {
    throw new Error(`${name || 'Version'} "${version}" is not a valid version (X.Y.Z[-suffix]).`)
  }
}

function setMageOsVendor(packageName, vendor) {
  return packageName.replace(/^magento\//, `${vendor}/`)
}

function updateMapFromMagentoToMageOs(obj, vendor) {
  const packageNames = Object.keys(obj)
  return packageNames.reduce((acc, pkg) => Object.assign(acc, {[setMageOsVendor(pkg, vendor)]: obj[pkg]}), {})
}

/**
 * @param {repositoryBuildDefinition} instruction 
 * @param {buildState} release
 * @param {{}} composerConfig
 */
function updateComposerDepsFromMagentoToMageOs(instruction, release, composerConfig) {
  composerConfig.name = setMageOsVendor(composerConfig.name, instruction.vendor)
  for (const dependencyType of ['require', 'require-dev', 'suggest', 'replace']) {
    composerConfig[dependencyType] && (composerConfig[dependencyType] = updateMapFromMagentoToMageOs(composerConfig[dependencyType], instruction.vendor))
  }
}

/**
 * @param {repositoryBuildDefinition} instruction 
 * @param {buildState} release
 * @param {{}} composerConfigPart
 * @param {String} dependencyType
 */
function setMageOsDependencyVersion(instruction, release, composerConfigPart, dependencyType) {
  const mageOsPackage = new RegExp(`^${vendor}/`)
  const packageNames = Object.keys(composerConfigPart)
  packageNames.forEach(packageName => {
    if (packageName.match(mageOsPackage)) {
      // @TODO: Allow vendor packages to be flagged as independently packaged. In that case, use the latest tagged version, not the current release or fallback version.
      // @TODO: Make sure release.version is actually set, or change this to ref, or instruction.version, or something -- think through this
      composerConfigPart[packageName] = release.version;
      
      if (dependencyType === 'suggest' && packageName.endsWith('-sample-data')) {
        composerConfigPart[packageName] = `Sample Data version: ${release.version}`;
      }
    }
  })
  return composerConfigPart
}

/**
 * @param {repositoryBuildDefinition} instruction 
 * @param {buildState} release
 * @param {{}} composerConfig
 */
// @TODO: update MageOs method names to Distribution
function updateComposerDepsVersionForMageOs(instruction, release, composerConfig) {
  for (const dependencyType of ['require', 'require-dev', 'suggest']) {
    composerConfig[dependencyType] && (composerConfig[dependencyType] = setMageOsDependencyVersion(instruction, release, composerConfig[dependencyType], dependencyType))
  }
}

/**
 * @param {repositoryBuildDefinition} instruction 
 * @param {buildState} release
 * @param {{}} composerConfig
 */
function updateComposerPluginConfigForMageOs(instruction, release, composerConfig) {
  if (composerConfig?.['config']?.['allow-plugins']) {
    Object.keys(composerConfig['config']['allow-plugins']).forEach(plugin => {
      const val = composerConfig['config']['allow-plugins'][plugin]
      delete composerConfig['config']['allow-plugins'][plugin]
      composerConfig['config']['allow-plugins'][setMageOsVendor(plugin, instruction.vendor)] = val
    })
  }
}

/**
 * Replace all occurrences of the magento vendor name with the given vendor in a composer.json
 *
 * This also happens for the "replace" section, before the given replaceVersionMap is merged.
 *
 * @param {repositoryBuildDefinition} instruction 
 * @param {buildState} release
 * @param {{}} composerConfig
 */
function updateComposerConfigFromMagentoToMageOs(instruction, release, composerConfig/* , releaseVersion, replaceVersionMap, vendor */) {
  const originalPackageName = composerConfig.name

  composerConfig.version = release.version || release.ref;
  composerConfig.name = setMageOsVendor(composerConfig.name, instruction.vendor);
  
  updateComposerDepsFromMagentoToMageOs(instruction, release, composerConfig/* , instruction.vendor */);
  updateComposerDepsVersionForMageOs(instruction, release, composerConfig/* , composerConfig.version, vendor */);
  updateComposerPluginConfigForMageOs(instruction, release, composerConfig/* , vendor */);

  if (release.dependencyVersions[originalPackageName]) {
    composerConfig.replace = {[originalPackageName]: release.dependencyVersions[originalPackageName]}
  }
}

/**
 * @param {repositoryBuildDefinition} instruction 
 * @param {packageDefinition} package
 * @param {buildState} release
 * @param {*} workingCopyPath 
 */
async function prepPackageForRelease(instruction, package, release, /* {label, dir}, repoUrl, ref, releaseVersion, vendor, replaceVersionMap, */ workingCopyPath) {
  console.log(`Preparing ${package.label}`);

  const composerConfig = JSON.parse(await readComposerJson(instruction.repoUrl, package.dir, release.ref))
  updateComposerConfigFromMagentoToMageOs(instruction, release, composerConfig/* , releaseVersion, replaceVersionMap, vendor */)

  // write composerJson to file in repo
  const file = path.join(workingCopyPath, package.dir, 'composer.json');
  await fs.writeFile(file, JSON.stringify(composerConfig, null, 2), 'utf8')
}

// @todo: here down!
async function buildMageOsProductCommunityEditionMetapackage(releaseVersion, instruction, replaceVersionMap, vendor) {
  console.log('Packaging Mage-OS Community Edition Product Metapackage');

  return createMagentoCommunityEditionMetapackage(instruction.repoUrl, instruction.ref, {
    release: releaseVersion,
    vendor,
    dependencyVersions: {'*': releaseVersion},
    transform: {
      [`${vendor}/product-community-edition`]: [
        (composerConfig) => {
          updateComposerConfigFromMagentoToMageOs(composerConfig, releaseVersion, replaceVersionMap, vendor)

          // Add upstreamRelease to composer extra data for reference
          composerConfig.extra = composerConfig.extra || {};
          composerConfig.extra.magento_version = replaceVersionMap['replaceVersionMap']['magento/product-community-edition'];

          return composerConfig
        }
      ]
    }
  })
}

async function buildMageOsProjectCommunityEditionMetapackage(releaseVersion, instruction, replaceVersionMap, vendor, dependencyVersions) {
  console.log('Packaging Mage-OS Community Edition Project');

  return createMagentoCommunityEditionProject(
    instruction,
    release,
    {
      minimumStability: 'stable',
      description: 'Community built eCommerce Platform for Growth',
      // @TODO: Handle this additional transform
      transform: {
        [`${vendor}/project-community-edition`]: [
          (composerConfig) => {
            updateComposerConfigFromMagentoToMageOs(composerConfig, releaseVersion, replaceVersionMap, vendor)
            return composerConfig
          }
        ]
      }
    }
  )
}


module.exports = {
  validateVersionString,
  updateComposerConfigFromMagentoToMageOs,
  async getPackageVersionMap(releaseVersion) {
    const dir = await composerCreateMagentoProject(releaseVersion);
    await installSampleData(dir);
    return getInstalledPackageMap(dir);
  },
  /**
   * @param {String} releaseVersion 
   * @param {String} vendor 
   * @param {repositoryBuildDefinition} instruction 
   * @param {{}} replaceVersionMap 
   * @returns {void}
   */
  async prepRelease(releaseVersion, vendor, instruction, replaceVersionMap) {
    const workBranch = `prep-release/${vendor}-${releaseVersion}`;

    const workingCopyPath = await repo.pull(instruction.repoUrl, instruction.ref);
    await repo.createBranch(instruction.repoUrl, workBranch, instruction.ref);

    for (const packageDirInstruction of instruction.packageDirs) {
      const childPackageDirs = await fs.readdir(path.join(workingCopyPath, packageDirInstruction.dir));

      for (let childPackageDir of childPackageDirs) {
        // Add trailing slash to our dir, so it matches excludes strings.
        if (packageDirInstruction.excludes.includes(childPackageDir + path.sep)) {
          // Skip directory
          continue;
        }

        const workingChildPackagePath = path.join(workingCopyPath, packageDirInstruction.dir, childPackageDir);

        if (!(await fs.lstat(workingChildPackagePath)).isDirectory()) {
          // Not a directory, skip
          continue;
        }

        const childPackageFiles = await fs.readdir(workingChildPackagePath);
        if (!childPackageFiles.includes('composer.json')) {
          throw new Error(`Error: ${workingChildPackagePath} doesn\'t contain a composer.json! Please add to excludes in config.`);
        }

        childPackageDir = path.join(packageDirInstruction.dir, childPackageDir);
        const composerJson = JSON.parse(await readComposerJson(instruction.repoUrl, childPackageDir, workBranch));

        const package = new packageDefinition({
          'label': `${composerJson.name} (part of ${packageDirInstruction.label})`,
          'dir': childPackageDir
        });
        await prepPackageForRelease(package, instruction.repoUrl, workBranch, releaseVersion, vendor, replaceVersionMap, workingCopyPath);
      }
    }

    for (const individualInstruction of (instruction.packageIndividual || [])) {
      await prepPackageForRelease(individualInstruction, instruction.repoUrl, workBranch, releaseVersion, vendor, replaceVersionMap, workingCopyPath);
    }

    for (const packageDirInstruction of (instruction.packageMetaFromDirs || [])) {
      await prepPackageForRelease(packageDirInstruction, instruction.repoUrl, workBranch, releaseVersion, vendor, replaceVersionMap, workingCopyPath)
    }

    if (instruction.magentoCommunityEditionMetapackage) {
      // nothing to do - the product-community-edition metapackage composer.json is built from a template
    }

    if (instruction.magentoCommunityEditionProject) {
      // update the base composer.json for releasing (doesn't happen for the base package because that uses a composer.json template)
      const package = new packageDefinition({
        'label': 'Mage-OS Community Edition Project Metapackage',
        'dir': ''
      });
      await prepPackageForRelease(package, instruction.repoUrl, workBranch, releaseVersion, vendor, replaceVersionMap, workingCopyPath)
    }

    return workBranch
  },

  /**
   * @param {*} mageosRelease 
   * @param {String} vendor 
   * @param {repositoryBuildDefinition} instruction 
   * @param {*} upstreamVersionMap 
   * @returns 
   */
  async processBuildInstructions(mageosRelease, vendor, instruction, upstreamVersionMap) {
    const dependencyVersions = {'*': mageosRelease}
    const fallbackVersion = mageosRelease

    const packages = {} // record generated packages with versions

    const {repoUrl, transform, ref, origRef} = instruction

    for (const packageDir of (instruction.packageDirs || [])) {
      const {label, dir, excludes} = Object.assign({excludes: []}, packageDir)
      console.log(`Packaging ${label}`)
      const built = await createPackagesForRef(instruction.repoUrl, instruction.dir, instruction.ref, {
        excludes,
        mageosRelease,
        fallbackVersion,
        dependencyVersions,
        transform,
        origRef,
        vendor
      })
      Object.assign(packages, built)
    }

    for (const individualPackage of (instruction.packageIndividual || [])) {
      const defaults = {excludes: [], composerJsonPath: '', emptyDirsToAdd: []}
      const {label, dir, excludes, composerJsonPath, emptyDirsToAdd} = Object.assign(defaults, individualPackage)
      console.log(`Packaging ${label}`)

      const built = await createPackageForRef(instruction.repoUrl, instruction.dir, instruction.ref, {
        excludes,
        composerJsonPath,
        emptyDirsToAdd,
        mageosRelease,
        fallbackVersion,
        dependencyVersions,
        transform,
        origRef,
        vendor
      })
      Object.assign(packages, built)
    }

    for (const packageMeta of (instruction.packageMetaFromDirs || [])) {
      const {label, dir} = packageMeta
      console.log(`Packaging ${label}`)
      const built = await createMetaPackageFromRepoDir(instruction.repoUrl, instruction.dir, instruction.ref, {mageosRelease, dependencyVersions, transform});
      Object.assign(packages, built)
    }

    if (instruction.magentoCommunityEditionMetapackage) {
      const built = await buildMageOsProductCommunityEditionMetapackage(mageosRelease, instruction, {replaceVersionMap: upstreamVersionMap}, vendor, dependencyVersions)
      Object.assign(packages, built)
    }

    if (instruction.magentoCommunityEditionProject) {
      const built = await buildMageOsProjectCommunityEditionMetapackage(mageosRelease, instruction, {replaceVersionMap: upstreamVersionMap}, vendor, dependencyVersions)
      Object.assign(packages, built)
    }

    return packages
  },
}
