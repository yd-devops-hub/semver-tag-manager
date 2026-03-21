const core = require('@actions/core');
const github = require('@actions/github');

const actorName = github.context.actor;
core.info(`Hello, ${actorName}! This action is initialized.`);
