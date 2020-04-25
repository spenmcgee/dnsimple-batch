# dnsimple-batch
A tool to execute dns changes across all your domains &amp; records

DNSimple is a great tool for DNS, but there isn't a way to search and replace values across all domains/zones/records.

This tool adds that functionality.

## Getting Started

* `git clone https://github.com/widepath/dnsimple-batch`
* `npm install`
* `export DNSIMPLE_ACCOUNTID=<yourid>`
* `export DNSIMPLE_V2_TOKEN=<yourtoken>`
* Now sync data: `node dnsimple-batch --sync`

## Sync

This tool operates on a cache of all the domains and records in your account - this is because DNSimple has no way to search across all records. So you need to first run the tool with `--sync` to download everything. First, all the domains are downloaded, then each domain's records are downloaded one by one. Syncing is subject to the same rate limits.

## DNSimple Rate Limits

* If you supply a valid token for requests, then the rate limit will be 2400/hour.
* Without a token it's 30/hour

The rate limit window resets every hour, so you can blow all 2400 requests in a few minutes then wait or you can throttle each to about 1.5 seconds.

You can use the `--throttle` option to control just this.
* `--throttle=0` will run as fast as possible
* `--throttle=1000` will run at `1/throttle*1000 Hz`
* Leaving `--throttle` out sets the throttle to 1500ms, which ensures that execution will proceed without interruption (if you start with a fresh rate limit window of 2400 requests/hour)

In any case, if you hit the end of a rate limit window, this tool will sleep until the next window. This ensures you can execute your operation without worrying it will halt.

For example, let's say you have 5000 domains and each has 10 records. The max pagination is to return 100 records, so you first use:
1. 5000/100 = 50 requests to get all the names
2. Another 5000 requests to get all the domain records
Total requests: 5050
This means you'll need: ceiling(5050/2400) = 3 rate limit windows

## Commit

No commits will execute unless you supply `--commit`. Without `--commit` the tool will just report the filters it executed and the operations it would execute, but nothing will change.

## Contexts

There are 2 contexts: **domain** and **record**.

It doesn't really make sense to add records in a record context. It only makes sense to add records in a domain context. So this is why the update/insert operations are split across these contexts.

### Domain Context

In the **domain** context, you have the following filters:
* `--filter-domain-has-records-with-content=<regex>`: Returns only the domains that have at least one record that have a record value matching the supplied regexp.
* `--filter-domain-has-no-records-with-content=<regex>`: Returns only the domains the DO NOT have ANY records whose values match the supplied regexp.

After filtering, you can insert records for each domain. Simply supply the `type`, `name` and `value` to insert a new record. Default `ttl` and `priority` values will be used.
* `--insert-record-type=<type>`
* `--insert-record-name=<name>`
* `--insert-record-value=<value>`

### Record Context

In the **domain** context, you have the following filters:
* `--filter-record-type=<value>`: Return only the records whose type matches the type supplied.
* `--filter-record-value=<regexp>`: Return only the records whose value matches the supplied regexp.

After filtering, you can update record values and also insert SPF record mechanisms.
* `--update-record-value=<value>`: Update the record with this new value
* `--update-record-value-ensure-spf-mechanism=<mechanism>`: Insert a non-duplicate mechanism into SPF records (eg: `include:sendgrid.net`)

### Both Contexts

You can `--filter-domain=<regexp>` in either an `domain` or `record` context. This means you only get back the domain/record whose domain name matches the supplied regexp.

## Examples

First, sync all data: `node dnsimple-batch --sync`

Let's say you need to update an IP address on all your domains: `node dnsimple-batch --filter-record-value=123.456.789.123 --update-record-value=8.8.8.8`

If it's an emergency, and you've got less than 2400 updates:
`node dnsimple-batch --filter-record-value=123.456.789.123 --update-record-value=8.8.8.8 --throttle=0`

Maybe it's a CNAME: `node dnsimple-batch --filter-record-type=CNAME --filter-record-value=blah.test.com --update-record-value=new.test.com`

Now, let's say you want to insert SPF records for all your domains:
`node dnsimple-batch --insert-record-type=TXT --insert-record-value='v=spf1 mx include:sendgrid.net ~all'`

Let's say you want to insert SPF records for only those domains that don't have an SPF:
`node dnsimple-batch --filter-domain-has-no-records-with-content='^v=spf1' --insert-record-type=TXT --insert-record-value='v=spf1 mx include:sendgrid.net ~all'`

Once you're happy with how it looks, add `--commit`:
`node dnsimple-batch --filter-domain-has-no-records-with-content='^v=spf1' --insert-record-type=TXT --insert-record-value='v=spf1 mx include:sendgrid.net ~all' --commit`

Now let's say you need to update your SPF records, but you want to insert a mechanism to the existing record:
`node dnsimple-batch --filter-record-value='^v=spf1' --update-record-value-ensure-spf-mechanism='include:sendgrid.net'`

## Log Levels

This tool is fairly verbose if you want it to be. If you don't include '--loglevel' then the default log level is 'info'. You can supply 3 log levels:
* '--loglevel=info': Shows pretty much everything
* '--loglevel=notice': Only important stuff
* '--loglevel=error': Only errors - useful for debugging problem
