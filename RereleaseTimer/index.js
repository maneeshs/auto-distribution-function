var request = require('request-promise');

module.exports = function (context, rereleaseTimer) {

    const token = process.env["APP_CENTER_TOKEN"];
    const rules = require('./config.json');

    const ruleSet = [];
    for(rule of rules) 
    {
        ruleSet.push(new Promise((resolve, reject) => {

            const owner = rule.owner;
            const app = rule.app;
            const source = rule.source;
            const destination = rule.destination;

            context.log(`Processing rule for ${app} (${source} -> ${destination})...`);

            var options = BuildUrl("/recent_releases", token, owner, app);
            return request(options) 
            .then(response => {
                var releases = JSON.parse(response);
                let release = GetLatest(releases, source);

                if(release) {

                    if(!IsInGroup(release, destination))
                    {
                        context.log(`Checking stats for version ${release.short_version}...`);
                        
                        var crashes = new Promise((resolve, reject) => {
                            var options = BuildUrl(`/analytics/crash_counts?start=${release.uploaded_at}&versions=${release.short_version}`, token, owner, app);
                            request(options)
                            .then(results => {
                                results = JSON.parse(results);
                                if(results.count) {
                                    resolve(results.count);
                                } else
                                    resolve(0);
                            })
                            .error(response => {
                                context.error(response);
                                reject(response);
                            });
                        }); 
                
                        var sessions = new Promise((resolve, reject) => {
                            var options = BuildUrl(`/analytics/session_durations_distribution?start=${release.uploaded_at}&versions=${release.short_version}`, token, owner, app);
                            request(options)
                            .then(results => {
                                results = JSON.parse(results);
                                if(results.distribution && results.distribution[2]) {
                                    resolve(results.distribution[2].count);
                                } else
                                    resolve(0);
                            })
                            .error(response => {
                                context.error(response);
                                reject(response);
                            });
                        }); 
                
                        var installs = new Promise((resolve, reject) => {
                            var options = BuildUrl(`/analytics/versions?start=${release.uploaded_at}&versions=${release.short_version}`, token, owner, app);
                            request(options)
                            .then(results => {
                                results = JSON.parse(results);
                                if (results.versions && results.versions[0]) {
                                    resolve(results.versions[0].count);
                                } else
                                    resolve(0);
                            })
                            .error(response => {
                                context.error(response);
                                reject(response);
                            });
                        }); 
            
                        Promise.all([crashes, sessions, installs ])
                        .then(values => { 
                            let [ crashes, sessions, installs ] = [ ...values ];

                            context.log(`Crashes Detected: ${crashes}`);
                            context.log(`Sessions (1-30min): ${sessions}`);
                            context.log(`Total Installs: ${installs}`);

                            if (crashes <= rule.crashes && installs >= rule.installs && sessions >= rule.sessions) {
                                context.log(`Re-releasing latest version...`);

                                return GetDistributionGroup(token, owner, app, destination)
                                .then(group => {
                                    if(group) {
                                        const destination = { id: group.id, name: group.name };
                                        return GetRelease(token, owner, app, release.id)
                                        .then(release => {
                                            if(release) {
                                                release.destination.push(destination);
                                                return Distribute(token, owner, app, release);
                                            }
                                        });

                                        resolve(true);
                                    } else {
                                        reject("Could not lookup destination group for re-release.");
                                    }
                                });
                            } else {
                                context.log(`Nothing to perform.`);
                                resolve(false);
                            }
                        });
                    } else {
                        context.log(`Latest release (${release.short_version}) has already been distributed to the destination.`);
                        resolve(false);
                    }
                } else {
                    context.log("No releases available in source.");
                    resolve(false);
                }
            })
            .error(response => {
                reject(error);
                context.error(response);
            });
        }));
    }

    Promise.all(ruleSet)
    .then(values => {
        context.log("Finished processing!");
        context.done();
    });
};

function BuildUrl(endpoint, token, owner, app) {
    const options = {
        headers: { 'Accept': 'application/json', 'X-API-Token': token },
        url: `https://api.mobile.azure.com/v0.1/apps/${owner}/${app}${endpoint}`
    };
    return options;
}

function GetLatest(releases, group) {
    for(z = 0; z < releases.length; z++) {
        if(IsInGroup(releases[z], group)) {
            return releases[z];
        }
    }
}

function IsInGroup(release, group) {
    if(release.distribution_groups) {
        for(i = 0; i < release.distribution_groups.length; i++) {
            if(release.distribution_groups[i].name == group)
                return true;
        }
    }
    return false;
}

function FindOne(endpoint, token, owner, app) {
    var options = BuildUrl(endpoint, token, owner, app);
    return request(options)
    .then(result => {
        result = JSON.parse(results);
        if (result) {
            return result[0];
        }
    })
    .error(response => {
        context.error(response);
        reject(response);
    });
}

function GetDistributionGroup(token, owner, app, group) {
    return FindOne(`/distribution_groups/${group}`, token, owner, app);
}

function GetRelease(token, owner, app, release) {
    return FindOne(`/releases/${release}`, token, owner, app);
}

function PatchRelease(token, owner, app, release) {
    const options = BuildUrl(`/releases/${release}`, token, owner, app);
    Object.assign(options, { method: "PATCH", body: JSON.stringify(release) })
    return request(options)
    .then(result => {
        resolve();
    })
    .error(response => {
        context.error(response);
        reject(response);
    });
}