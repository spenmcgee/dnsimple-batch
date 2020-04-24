const fs = require('fs');
const util = require('util');
const winston = require('winston');
const request = require('request');
const moment = require('moment');
const minimist = require('minimist');
const os = require('os');
const path = require('path');
const spfvalidate = require('spf-parse');

const DNSIMPLE_V2_TOKEN = process.env.DNSIMPLE_V2_TOKEN;
const DNSIMPLE_ACCOUNTID = process.env.DNSIMPLE_ACCOUNTID;

const argv = minimist(process.argv.slice(2));
const commit = argv['commit'] ? true : false;
const throttle = ('throttle' in argv) ? argv['throttle'] : 1500;
const logLevel = argv['loglevel'] ? argv['loglevel'] : 'notice';
const cacheFile = path.join(os.homedir(), '.dnsbatch.json')

var logger = winston.createLogger({
  exitOnError: false,
  levels: (winston.config.syslog.levels),
  transports: [new winston.transports.Console({level: logLevel})],
  format: winston.format.simple()
});

async function remoteCall(method, path, data) {
  uri = `https://api.dnsimple.com/v2/${path}`
  return new Promise((resolve, reject) => {
    request({
      method: method,
      uri: uri,
      json: data||true,
      headers: {
        Authorization: `Bearer ${DNSIMPLE_V2_TOKEN}`
      }
    },
    function (err, response, body) {
      if (err) reject(err);
      else {
        var resp = {
          body: body,
          rateLimitLimit: response.headers['x-ratelimit-limit'],
          rateLimitRemaining: response.headers['x-ratelimit-remaining'],
          rateLimitReset: response.headers['x-ratelimit-reset'],
          statusCode: response.statusCode,
          statusMessage: response.statusMessage
        }
        var rateLimitResetReadable = moment(response.headers['x-ratelimit-reset']*1000+60000).fromNow();
        logger.info(`[remoteCall] (${resp.rateLimitRemaining} remaining, reset ${rateLimitResetReadable}) ${method} ${path} returned ${resp.statusCode}: ${resp.statusMessage}`)
        if ((resp.rateLimitRemaining <= 1) || resp.statusCode == 429) {
          var ms = resp.rateLimitReset * 1000 + 60000 - new Date().getTime();
          logger.notice(`[remoteCall] Sleeping until next rate limit window, ${rateLimitResetReadable} (from ${new Date()})`);
          setTimeout(() => resolve(resp), ms);
        } else if (throttle) setTimeout(() => resolve(resp), throttle);
        else resolve(resp);
      }
    })
  })
}

async function getDomainPage(page) {
  var resp = await remoteCall('get', `${DNSIMPLE_ACCOUNTID}/zones?per_page=100&page=${page}`);
  logger.info(`[getDomainPage] Got domain page ${page} of ${resp.body.pagination.total_pages}`)
  return resp;
}

async function getAllDomains() {
  var domains = [];
  var resp = await getDomainPage(1);
  for (var p=1; p<=resp.body.pagination.total_pages; p++) {
    resp = await getDomainPage(p);
    domains = domains.concat(resp.body.data.map(x=>x.name));
  }
  return domains;
}

async function getDomainRecords(domain) {
  var resp = await remoteCall('get', `${DNSIMPLE_ACCOUNTID}/zones/${domain}/records?per_page=100`);
  return resp;
}

async function getAllDomainRecords(domains) {
  var records = []
  for (var i=0; i<domains.length; i++) {
    var resp = await getDomainRecords(domains[i])
    records = records.concat(resp.body.data.map(r => {
      return {
        id: r.id,
        domain: r.zone_id,
        type: r.type,
        name: r.name,
        ttl: r.ttl,
        priority: r.priority,
        content: r.content
      }
    }));
    logger.info(`[getDomainRecords] (${i+1}/${domains.length}) Got ${resp.body.data.length} domain records for ${domains[i]}`);
  }
  return records.flat();
}

function filterDomainsHasRecordWithContent(data, domains, regexp, shouldExist) {
  return domains.filter(domain => {
    var records = data.recordsByDomain[domain];
    var exists = records.reduce((e,r) => {
      if (r.content.search(regexp) >= 0)
        return true || e;
      else
        return false || e;
    }, false);
    return shouldExist ? exists : !exists;
  })
}

function filterDomainsByDomain(data, domains, re) {
  return domains.filter(domain => domain.search(re) >= 0)
}

function canonicalArgsArray(argName) {
  if (!(argName in argv))
    return [];
  else if (typeof argv[argName] == 'string')
    return [argv[argName]];
  else
    return argv[argName];
}

function filterDomains(data) {
  var domains = data.domains;
  var filters = [];

  args = canonicalArgsArray('filter-domain');
  var funcs = args.map(re => records => filterDomainsByDomain(data, domains, new RegExp(re)));
  filters = filters.concat(funcs);

  args = canonicalArgsArray('filter-domain-has-no-records-with-content');
  var funcs = args.map(re => domains => filterDomainsHasRecordWithContent(data, domains, new RegExp(re), false));
  filters = filters.concat(funcs);

  args = canonicalArgsArray('filter-domain-has-records-with-content');
  var funcs = args.map(re => domains => filterDomainsHasRecordWithContent(data, domains, new RegExp(re), true));
  filters = filters.concat(funcs);

  filters.forEach(filter => {
    domains = filter(domains);
  })
  return domains;
}

async function insertRecord(domain, type, name, value) {
  logger.info(`[insertRecord] ${domain} ${type} ${name||'@'} ${value}`);
  if (commit) {
    await remoteCall('post', `${DNSIMPLE_ACCOUNTID}/zones/${domain}/records`, {
      name: name||'',
      type: type,
      content: value
    })
  }
}

async function domainOperations(data) {
  logger.notice(`[domainOperations] Before filter ${data.domains.length}`)
  domains = filterDomains(data);
  logger.notice(`[domainOperations] After filter, ${domains.length} domains ready to party`)
  var count = 0, total = domains.length;
  for (var i=0; i<domains.length; i++) {
    if (argv['insert-record-type'] && argv['insert-record-value']) {
      logger.info(`[domainOperation] domain ${i} of ${total}`);
      count += 1;
      await insertRecord(domains[i], argv['insert-record-type'], argv['insert-record-name'], argv['insert-record-value']);
    }
  }
  return count;
}

function filterRecordsByDomain(data, records, re) {
  return records.filter(record => record.domain.search(re) >= 0)
}

function filterRecordsByType(data, records, type) {
  return records.filter(record => record.type == type)
}

function filterRecordsByValue(data, records, re) {
  return records.filter(record => record.content.search(re) >= 0)
}

function filterRecords(data) {
  var records = data.records;
  var filters = [];

  args = canonicalArgsArray('filter-domain');
  var funcs = args.map(re => records => filterRecordsByDomain(data, records, new RegExp(re)));
  filters = filters.concat(funcs);

  args = canonicalArgsArray('filter-record-type');
  var funcs = args.map(type => records => filterRecordsByType(data, records, type));
  filters = filters.concat(funcs);

  args = canonicalArgsArray('filter-record-value');
  var funcs = args.map(re => records => filterRecordsByValue(data, records, new RegExp(re)));
  filters = filters.concat(funcs);

  filters.forEach(filter => {
    records = filter(records);
  })
  return records;
}

async function updateRecordValue(record, value) {
  logger.info(`[updateRecordValue] ${record.type} ${record.name||'@'} ${record.content} > ${value}`);
  if (commit) {
    await remoteCall('patch', `${DNSIMPLE_ACCOUNTID}/zones/${domain}/record/${record.id}`, {
      content: value
    })
  }
}

function spfAssemble(components) {
  components = components.sort((a,b) => a.sort-b.sort);
  var values = components.map(c => c.content);
  values = values.filter((elem, pos) => values.indexOf(elem) == pos) //unique
  values = values.filter(v => v != 'include:websites.ca')
  values = values.filter(v => v != 'include:widepath.io')
  values = values.filter(v => v != 'include:amazonses.com')
  return values.join(' ');
}

function spfParse(record) { //fairly correct, needs more work
  const regExpArray = [
    {type:'all', re:/[-,+,?,~]all/i, sort:1},
    {type:'mech', re:/^[-,+]{0,1}include:.*$/i, sort:0},
    {type:'mech', re:/ip4:.*$/i, sort:0},
    {type:'mech', re:/ip6:.*$/i, sort:0},
    {type:'mech', re:/^[-,+]{0,1}a$/i, sort:0},
    {type:'mech', re:/[-,+]{0,1}mx$/i, sort:0},
    {type:'mech', re:/ptr/i, sort:0},
    {type:'mech', re:/exists/i, sort:0},
    {type:'version', re:/v=spf1/i, sort:-1}
  ]
  var data = [], components = record.split(" ");
  components.map(component => {
    regExpArray.forEach(r => {
      const match = component.match(r.re)
      if (match) {
        return data.push({ content: match[0], type:r.type, sort:r.sort });
      }
    });
  });
  return data;
}

function validateSpf(spf, domain) {
  var res = spfvalidate(spf);
  if ((!res.valid) || (res.messages))
    logger.error(`[validateSpf] ${domain} Invalid SPF '${spf}': ${JSON.stringify(res.messages)}`)
}

async function updateRecordValueEnsureSpfMechanism(record, spfMech) {
  validateSpf(record.content, record.domain);
  var components = spfParse(record.content);
  components.push({content:spfMech, type:'mech', sort:0})
  var newValue = spfAssemble(components);
  validateSpf(newValue, record.domain);
  logger.info(`[updateRecordValueEnsureSpfMechanism] ${record.domain} ${record.type} ${record.name||'@'} ${record.content} > ${newValue}`);
  if (commit) {
    await remoteCall('patch', `${DNSIMPLE_ACCOUNTID}/zones/${domain}/record/${record.id}`, {
      content: newValue
    })
  }
}

async function recordOperations(data) {
  logger.notice(`[recordOperations] Before filter ${data.records.length}`)
  records = filterRecords(data);
  logger.notice(`[recordOperations] After filter, ${records.length} records ready to party`)
  var count = 0, total = records.length;
  for (var i=0; i<records.length; i++) {
    if (argv['update-record-value']) {
      count+=1;
      logger.info(`[recordOperations] record ${count} of ${total}`);
      await updateRecordValue(records[i], argv['update-record-value']);
    } else if (argv['update-record-value-ensure-spf-mechanism']) {
      count+=1;
      logger.info(`[recordOperations] record ${count} of ${total}`);
      await updateRecordValueEnsureSpfMechanism(records[i], argv['update-record-value-ensure-spf-mechanism']);
    }
  }
  return count;
}

function usage() {
  console.log(`node dns-batch [options]
Search domains and records in dnsimple then insert or update records.

  --commit (commits changes)
  --throttle=<time_in_ms> (throttles api calls to frequency 1/time_in_ms Hz, defaults to 1500 which ensures continuous execution across rate limit reset windows, set lower if you want to move faster)
  --sync (force fresh download of all domains and records)

  domain context:
  --filter-domain-has-records-with-content=<regex>
  --filter-domain-has-no-records-with-content=<regex>
  --insert-record-type=<type>
  --insert-record-name=<name>
  --insert-record-value=<value>

  record context:
  --filter-record-type=<value> (filter by record type, case insensitive)
  --filter-record-value=<regexp> (filter by record value)
  --update-record-value=<value> (updates the record value)
  --update-record-value-ensure-spf-mechanism=<mechanism> (updates the spf record by inserting a mechanism, eg. include:<domain> or a, there's a bit of validation, you can run --loglevel=error to see validation errors only)

  both context:
  --filter-domain=<regexp>

Filter what you want to update using the *filter* options, then update those records using the *update/insert* options.
`)
}

async function sync() {
  logger.notice(`[sync] start`);
  var domains = await getAllDomains();
  var records = await getAllDomainRecords(domains);
  var data = {domains:domains, records:records};
  logger.notice(`[sync] writing cache`);
  fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2));
  return {
    domains: domains,
    records: records
  }
}

async function load() {
  logger.notice(`[load] loading from cache file`);
  try {
    var json = fs.readFileSync(cacheFile);
    var data = JSON.parse(json);
    data.recordsByDomain = data.records.reduce((o,r) => {
      if (!(r.domain in o)) o[r.domain] = [];
      o[r.domain].push(r);
      return o;
    }, {});
    return data;
  } catch (err) {
    if (err.code == 'ENOENT') {
      logger.error("Cache file is missing, run with --sync first");
      process.exit(-1);
    }
  }
}

async function main() {
  logger.notice(`Starting, throttle @ ${1/throttle*1000} Hz, committing? ${commit?'yes':'no'}, cacheFile: ${cacheFile}`)
  if (argv['help']) {
    usage();
  } else if ((!DNSIMPLE_V2_TOKEN) || (!DNSIMPLE_ACCOUNTID)) {
    logger.error("Missing DNSIMPLE_ACCOUNTID and DNSIMPLE_V2_TOKEN environment variables.");
  } else {
    if (argv['sync']) await sync();
    var data = await load();
    logger.notice(`[main] Ready to party with ${data.domains.length} domains and ${data.records.length} records`)
    var domainOps = await domainOperations(data);
    logger.notice(`[main] ${domainOps} domain operations`)
    var recordOps = await recordOperations(data);
    logger.notice(`[main] ${domainOps} domain operations`)
    logger.notice(`[main] ${recordOps} record operations`)
  }
}

main()
