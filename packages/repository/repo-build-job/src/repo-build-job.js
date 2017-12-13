'use strict'
const path = require('path')
const {
  artifactsToBuildFromChange,
  buildsThatCanBeBuilt,
  createDependencyGraph,
} = require('@bildit/artifact-dependency-graph')
const debug = require('debug')('bildit:repo-build-job')

module.exports = ({plugins: [binaryRunner, repositoryFetcher]}) => {
  return {
    async setupBuildSteps({agentInstance, state, awakenedFrom}) {
      debug('running job repo-build-job')

      const {directory} = await repositoryFetcher.fetchRepository({agentInstance})

      const {stdout: text} = awakenedFrom
        ? {stdout: undefined}
        : await binaryRunner.run({
            binary: '@bildit/artifact-finder',
            executeCommandArg: {
              agentInstance,
              command: ['artifact-finder', directory],
              returnOutput: true,
            },
          })
      const initialAllArtifacts = awakenedFrom ? undefined : JSON.parse(text)

      return {howToBuild: {state, awakenedFrom, initialAllArtifacts}}
    },
    getBuildSteps({
      howToBuild: {state, awakenedFrom, initialAllArtifacts},
      job: {linkDependencies, filesChangedSinceLastBuild},
    }) {
      state = state || {
        allArtifacts: initialAllArtifacts,
        dependencyGraph: artifactsToBuildFromChange(
          createDependencyGraph(initialAllArtifacts),
          artifactsFromChanges(initialAllArtifacts, filesChangedSinceLastBuild),
        ),
        alreadyBuiltArtifacts: [],
      }
      const alreadyBuiltArtifacts =
        awakenedFrom && awakenedFrom.result.success
          ? state.alreadyBuiltArtifacts.concat(awakenedFrom.job.artifactName)
          : awakenedFrom && !awakenedFrom.result.success
            ? state.alreadyBuiltArtifacts.concat(
                Object.keys(
                  artifactsToBuildFromChange(state.dependencyGraph, [
                    awakenedFrom.job.artifactName,
                  ]),
                ),
              )
            : []

      const artifactsToBuild = buildsThatCanBeBuilt(state.dependencyGraph, alreadyBuiltArtifacts)

      if (!artifactsToBuild || artifactsToBuild.length === 0) {
        return {}
      }
      const artifactToBuild = artifactsToBuild[0]

      debug('building artifact %s', artifactToBuild)

      const artifactJob = createJobFromArtifact(
        state.allArtifacts.find(a => a.name === artifactToBuild),
        linkDependencies ? state.allArtifacts : undefined,
        filesChangedSinceLastBuild,
      )

      debug('decided to run sub-job %o', artifactJob)

      return {
        state: {
          ...state,
          ...{alreadyBuiltArtifacts},
        },
        jobs: [artifactJob].map(job => ({job, awaken: true})),
      }
    },
  }
}

function artifactsFromChanges(artifacts, filesChangedSinceLastBuild) {
  return artifacts
    .filter(
      artifact =>
        !filesChangedSinceLastBuild ||
        filesChangedSinceLastBuild.find(file => file.startsWith(artifact.path + '/')),
    )
    .map(artifact => artifact.name)
}

module.exports.plugins = ['binaryRunner:npm', 'repositoryFetcher']

const createJobFromArtifact = (artifact, artifacts, filesChangedSinceLastBuild) => ({
  kind: artifact.type,
  artifactName: artifact.name,
  artifactPath: artifact.path,
  dependencies: artifacts ? artifact.dependencies : [],
  artifacts,
  filesChangedSinceLastBuild:
    filesChangedSinceLastBuild &&
    filesChangedSinceLastBuild.map(f => path.relative(artifact.path, f)),
})
