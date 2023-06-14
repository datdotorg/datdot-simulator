const RAM = require('random-access-memory')
const derive_topic = require('derive-topic')
const hypercore = require('hypercore')
const Hyperbeam = require('hyperbeam')
const brotli = require('_datdot-service-helpers/brotli')
const varint = require('varint')
const b4a = require('b4a')

const { performance } = require('perf_hooks')

const datdot_crypto = require('datdot-crypto')
const proof_codec = require('datdot-codec/proof')
const {done_task_cleanup} = require('_datdot-service-helpers/done-task-cleanup')
const parse_decompressed = require('_datdot-service-helpers/parse-decompressed')

const tempDB = require('_tempdb')
const getRangesCount = require('getRangesCount')
const compare_encodings = require('compare-encodings')
const get_max_index = require('_datdot-service-helpers/get-max-index')
const get_index = require('_datdot-service-helpers/get-index')
const DEFAULT_TIMEOUT = 10000

/******************************************************************************
  ROLE: Attester
******************************************************************************/

module.exports = APIS => { 
  
  return attester

  async function attester (vaultAPI) {
    const { chainAPI } = APIS
    const account = vaultAPI
    const { identity, log, hyper } = account
    const { myAddress, signer, noiseKey: attesterKey } = identity
    // log({ type: 'attester', data: [`I am an attester`] })
    const jobsDB = await tempDB(attesterKey)
    chainAPI.listenToEvents(handleEvent)

  /* ----------------------------------------------------------------------
                              EVENTS
  ---------------------------------------------------------------------- */

    async function handleEvent (event) {
      if (event.method === 'UnpublishPlan') {
        const [planID] = event.data
        const jobIDs = unpublishedPlan_jobIDs(planID)
        jobIDs.forEach(jobID => {
          const job = jobsDB.get(jobID)
          if (job) { /* TODO: ... */ }
        })
      }
      if (event.method === 'DropHosting') {
        attesterAddress
        const [planID] = event.data
        const jobIDs = unpublishedPlan_jobIDs(planID)
        jobIDs.forEach(jobID => {
          const job = jobsDB.get(jobID)
          if (job) { /* TODO: ... */ }
        })
      }
      else if (event.method === 'NewAmendment') {
        const [amendmentID] = event.data
        const amendment = await chainAPI.getAmendmentByID(amendmentID)
        const contract = await chainAPI.getContractByID(amendment.contract)
        const [attesterID] = amendment.providers.attesters
        const attesterAddress = await chainAPI.getUserAddress(attesterID)
        if (attesterAddress !== myAddress) return

        log({ type: 'attester', data: { text: `Attester ${attesterID}: Event received: ${event.method} ${event.data.toString()}`, amendment: JSON.stringify(amendment)} })
        const { feedKey, encoderKeys, hosterSigningKeys, hosterKeys, ranges } = await getAmendmentData({amendment, contract,log})
        
        const data = { account, amendmentID, feedKey, hosterKeys, attesterKey, encoderKeys, hosterSigningKeys, ranges, log }
        const { failedKeys, sigs } = await attest_hosting_setup(data)
        log({ type: 'attester', data: { text: `Hosting setup done`, amendmentID, failedKeys, sigs } })
        const signatures = {}
        for (const sig of sigs) {
          const { proof_of_contact, hosterKey } = sig
          const hoster_id = await chainAPI.getUserIDByNoiseKey(b4a.from(hosterKey, 'hex'))
          signatures[hoster_id] = proof_of_contact
        }
        const report = { id: amendmentID, failed: failedKeys, signatures }
        const nonce = await vaultAPI.getNonce()
        await chainAPI.amendmentReport({ report, signer, nonce })
      }
      else if (event.method === 'HostingStarted') {
        const [amendmentID] = event.data
      }
      else if (event.method === 'NewStorageChallenge') {
        const [storageChallengeID] = event.data
        const storageChallenge = await chainAPI.getStorageChallengeByID(storageChallengeID)
        const { attester: attesterID, checks } = storageChallenge
        const attesterAddress = await chainAPI.getUserAddress(attesterID)
        if (attesterAddress !== myAddress) return
        log({ type: 'chainEvent', data: `Attester ${attesterID}:  Event received: ${event.method} ${event.data.toString()}` })      
        try {
          const data = await get_storage_challenge_data(storageChallenge)
          const res = await attest_storage_challenge({ data, account, log })
          if (res) {
            const { proof_of_contact, reports } = res
            const nonce = await vaultAPI.getNonce()
            const attestation = { 
              response: { storageChallengeID, proof_of_contact, reports }, 
              signer, 
              nonce
            }
            await chainAPI.submitStorageChallenge(attestation)
          }
        } catch (err) {
          log({ type: 'error', data: { text: `Error: ${JSON.stringify(err)}` } })
        }
      }
      else if (event.method === 'NewPerformanceChallenge') {
        const [performanceChallengeID] = event.data
        const performanceChallenge = await chainAPI.getPerformanceChallengeByID(performanceChallengeID)
        const { hosters, attesters, feed: feedID } = performanceChallenge
        const [attesterID] = attesters
        const attesterAddress = await chainAPI.getUserAddress(attesterID)
        if (attesterAddress !== myAddress) return
        log({ type: 'chainEvent', data: { text: 'new-performance-challenge', info: `Attester ${attesterID}:  Event received: ${event.method} ${event.data.toString()}` } })
        const feedObj = await chainAPI.getFeedByID(feedID)
        const { feedkey, contracts: contractIDs } = feedObj
        log({ type: 'challenge', data: { text: 'Performance challenge for feed', feedObj } })
        var reports = {}
        var expected_chunks_len
        var proof_of_contact
        const { chunks, targetList } = await get_hosters_and_challenge_chunks(contractIDs)
        // get all hosters and select random chunks to check for each hoster
        
        async function get_hosters_and_challenge_chunks (contractIDs) {
          return new Promise (async(resolve, reject) => {
            try {
              const chunks = {}
              const all_ids = []
              for (var i = 0, len1 = contractIDs.length; i < len1; i++) {
                const contract = await chainAPI.getContractByID(contractIDs[i])
                const { amendments, ranges } = contract
                const active_amendment = await chainAPI.getAmendmentByID(amendments[amendments.length-1])
                var { providers: { hosters: hoster_ids } } = active_amendment
                log({ type: 'challenge', data: { text: 'Getting hosters and chunks for contract' } })
                for (var j = 0, len2 = hoster_ids.length; j < len2; j++) {
                  const id = hoster_ids[j]
                  all_ids.push(id)
                  const x = getRandomInt(0, ranges.length)
                  log({ type: 'attester', data: { text: 'Selecting random range', ranges, x } })
                  const random_range = ranges[x]
                  chunks[id] = { indexes: [] } // chain doesn't emit WHICH chunks attester should check
                  chunks[id].indexes.push(getRandomInt(random_range[0], random_range[1]))
                }
              }
              // when we have 2x same hoster - we check chunks from all contracts at once
              hoster_ids = [...new Set(all_ids)]
              expected_chunks_len = hoster_ids.length
              const targetListPromise = hoster_ids.map(async id => (await chainAPI.getHosterKey(id)).toString('hex'))
              const targetList = await Promise.all(targetListPromise)
              log({ type: 'performance challenge', data: { text: 'targetList and chunks to test', all_ids, targetList, chunks: JSON.stringify(chunks) } })
              resolve({ chunks, targetList })
            } catch (err) {
              log({ type: 'performance challenge', data: { text: 'Error in get_hosters_and_challenge_chunks', err: JSON.stringify(err) } })
              reject()
            }
          })
        }
        

        // join swarm and check performance when you connect to any of the hosters

        const topic =  datdot_crypto.get_discoverykey(feedkey)
        const { feed } = await hyper.new_task({ feedkey, topic, log })

        await hyper.connect({ 
          swarm_opts: { role: 'performance_attester', topic, mode: { server: false, client: true } }, 
          targets: { targetList, feed, ontarget: onhoster_for_performance_challenge, done },
          log
        })
          
        log({ type: 'challenge', data: { text: 'Got performance challenge feed', fedkey: feed.key.toString('hex') } })
        
        async function onhoster_for_performance_challenge ({ remotestringkey: hosterkey }) {
          log({ type: 'attester', data: { text: 'connected to the host for performance challenge', hoster: hosterkey.toString('hex') }})
          const hoster_id = await chainAPI.getUserIDByNoiseKey(hosterkey)
          await feed.update()
          const opts = { account, performanceChallengeID, feed, chunks: chunks[hoster_id.toString()], hosterkey, topic, log }
          const stats = await check_performance(opts).catch(err => log({ type: 'fail', data: err })) || []
          reports[hoster_id] ? reports[hoster_id].stats = stats : reports[hoster_id] = { stats }
          done()
        }
        
        async function done (proof, hosterkey) { // performance challenge
          // called 2x: when (reports_promises.length === expected_chunks_len) and when hoster sends proof of contact
          if (proof) {
            const proof_buff = b4a.from(proof, 'hex')
            const hoster_id = await chainAPI.getUserIDByNoiseKey(hosterkey)
            const hostersigningkey = await chainAPI.getSigningKey(hoster_id)
            const data = b4a.from(performanceChallengeID.toString(), 'binary')
            log({ type: 'attester', data: { text: 'done called', proof_buff, hostersigningkey, hosterkey }})
            if (!datdot_crypto.verify_signature(proof_buff, data, hostersigningkey)) log({ text: 'error: not valid proof of contact', hosterkey, proof, data})
            proof_of_contact = proof
            reports[hoster_id] ? reports[hoster_id].proof_of_contact = proof_of_contact : reports[hoster_id] = { proof_of_contact }
          }          
          if (!proof_of_contact) return

          const hoster_ids = Object.keys(reports)
          if (hoster_ids.length !== expected_chunks_len) return

          // verify reports
          for (const id of hoster_ids) {
            const { stats, proof_of_contact } = reports[id]
            if (!stats || !proof_of_contact) return
          }

          log({ type: 'attester', data: { text: 'have proof and reports', proof, reports }})
          done_task_cleanup({ role: 'performance_attester', topic, remotestringkey: hosterkey.toString('hex'), state: account.state, log })
          
          // TODO: send just a summary to the chain, not the whole array
          const nonce = await vaultAPI.getNonce()
          log({ type: 'attester', data: `Submitting performance challenge` })
          await chainAPI.submitPerformanceChallenge({ performanceChallengeID, reports, signer, nonce })
        }
      }
    }

    async function get_storage_challenge_data (storageChallenge) {
      const { id, checks, hoster: hosterID, attester: attesterID } = storageChallenge
      const contract_ids = Object.keys(checks).map(stringID => Number(stringID))
      const hosterSigningKey = await chainAPI.getSigningKey(hosterID)
      const hosterKey = await chainAPI.getHosterKey(hosterID)
      const attesterKey = await chainAPI.getAttesterKey(attesterID)
      var feedkey_1
      for (var i = 0, len = contract_ids.length; i < len; i++) {
        const contract_id = contract_ids[i]
        const contract = await chainAPI.getItemByID(contract_id)
        const { feed: feed_id, ranges, amendments } = await chainAPI.getContractByID(contract_id)
        const [encoderID, pos] = await getEncoderID(amendments, hosterID)
        const { feedkey, signatures } = await chainAPI.getFeedByID(feed_id)
        if (!feedkey_1) feedkey_1 = feedkey
  
        checks[contract_id].feedKey = feedkey
        checks[contract_id].signatures = signatures
        checks[contract_id].ranges = ranges
        checks[contract_id].encoderSigningKey = await chainAPI.getSigningKey(encoderID)
        checks[contract_id].encoder_pos = pos
        checks[contract_id].amendmentID = amendments[amendments.length - 1]
        // checks[contract_id] = { index, feedKey, signatures, ranges, amendmentID, encoder_pos, encoderSigningKey }
      }
      return { id, attesterKey, hosterKey, hosterSigningKey, checks, feedkey_1 }
    }
  
    async function getEncoderID (amendments, hosterID) {
      const active_amendment = await chainAPI.getAmendmentByID(amendments[amendments.length-1])
      const pos =  active_amendment.providers.hosters.indexOf(hosterID)
      const encoderID = active_amendment.providers.encoders[pos]
      return [encoderID, pos]
    }
  
    async function getAmendmentData ({ amendment, contract, log }) {
      const { encoders, hosters } = amendment.providers
      const hosterKeysPromises = []
      const hosterSigningKeysPromises = []
      hosters.forEach(id => {
        hosterKeysPromises.push(chainAPI.getHosterKey(id))
        hosterSigningKeysPromises.push(chainAPI.getSigningKey(id))
      })
      const encoderKeys = await Promise.all(encoders.map((id) => chainAPI.getEncoderKey(id)))
      const hosterKeys = await Promise.all(hosterKeysPromises)
      const hosterSigningKeys = await Promise.all(hosterSigningKeysPromises)
      const feedID = contract.feed
      const feedKey = await chainAPI.getFeedKey(feedID)
      const ranges = contract.ranges
      log({ type: 'attester', data: { text: `Got keys for hosting setup`, data: feedKey, providers: amendment.providers, encoderKeys, hosterKeys, ranges } })
      return { feedKey, encoderKeys, hosterSigningKeys, hosterKeys, ranges }
    }
  
  }

  /* ----------------------------------------------------------------------
                              HOSTING SETUP
  ---------------------------------------------------------------------- */

  async function attest_hosting_setup (data) {
    return new Promise(async (resolve, reject) => {
      const { account, amendmentID, feedKey, hosterKeys, attesterKey, encoderKeys, hosterSigningKeys, ranges, log } = data
      try {
        const messages = {}
        const responses = []
        const encoders_len = encoderKeys.length
        // log({ type: 'attester', data: { text: `Attest hosting setup`, amendmentID, encoderKeys } })
        for (var i = 0, len = encoders_len; i < len; i++) {
          const encoderKey = await encoderKeys[i]
          const hosterKey = await hosterKeys[i]
          const topic1 = derive_topic({ senderKey: encoderKey, feedKey, receiverKey: attesterKey, id: amendmentID, log })
          const topic2 = derive_topic({ senderKey: attesterKey, feedKey, receiverKey: hosterKey, id: amendmentID, log }) 

          const unique_el = `${amendmentID}/${i}`
          const hosterSigningKey = hosterSigningKeys[i]

          const opts = { account, topic1, topic2, encoderKey, hosterSigningKey, hosterKey, unique_el, ranges, log }
          opts.compare_CB = (msg, key) => compare_encodings({ messages, key, msg, log })
          responses.push(verify_and_forward_encodings(opts))
        }
        
        const resolved_responses = await Promise.all(responses) // can be 0 to 6 pubKeys of failed providers
        const failedKeys = []
        const sigs = []
        // log({ type: 'attester', data: { text: `Resolved responses!`, resolved_responses } })
        for (const res of resolved_responses) {
          const { failedKeys: failed, proof_of_contact, hosterKey } = res
          failedKeys.push(failed)
          sigs.push({ proof_of_contact, hosterKey })
        }
        // log({ type: 'attester', data: { text: 'resolved responses', amendmentID, failed, sigs_len: sigs.length } })
        const report = { failedKeys: [...new Set(failedKeys.flat())], sigs }        
        resolve(report)
      } catch(err) {
        log({ type: 'fail', data: { text: 'Error: attest_hosting_setup', err }})
        const failedKeys = []
        for (const key of encoderKeys) failedKeys.push(key.toString('hex'))
        for (const key of hosterKeys) failedKeys.push(key.toString('hex'))
        reject({ failedKeys, sigs: [] })
      }
    })
  }
    
  async function verify_and_forward_encodings (opts) {
    const { account, topic1, topic2, encoderKey, hosterSigningKey, hosterKey, unique_el, ranges, compare_CB, log } = opts
    const failedKeys = []
    return new Promise(async (resolve, reject) => {
      const tid = setTimeout(() => {
        log({ type: 'attester', data: { text: 'verify_and_forward_encodings timeout', hosterKey: hosterKey.toString('hex') }})
        failedKeys.push(encoderKey.toString('hex'), hosterKey.toString('hex'))
        reject({ failedKeys })
      }, DEFAULT_TIMEOUT)
      try {
        // log({ type: 'attester', data: { text: 'calling connect_compare_send', encoderKey: encoderKey.toString('hex') }})
        const proof_of_contact = await connect_compare_send({
          account,
          topic1, 
          topic2, 
          compare_CB, 
          key1: encoderKey, 
          key2: hosterKey, 
          hosterSigningKey,
          unique_el,
          ranges,
          log
        })
        log({ type: 'attester', data: { text: 'All compared and sent, resolving now', encoderKey: encoderKey.toString('hex'), proof_of_contact }})
        if (!proof_of_contact) failedKeys.push(hosterKey)
        clearTimeout(tid)
        resolve({ failedKeys, proof_of_contact, hosterKey })
      } catch (err) {
        log({ type: 'attester', data: { text: 'Error: verify_and_forward_encodings', hosterKey: hosterKey.toString('hex') }})
        failedKeys.push(encoderKey.toString('hex'), hosterKey.toString('hex'))
        reject({ failedKeys })
      }
    })
  }
  
  async function connect_compare_send (opts) {
    const { account, topic1, topic2, key1, key2, hosterSigningKey, unique_el, compare_CB, ranges, log } = opts
    const { hyper } = account
    const expectedChunkCount = getRangesCount(ranges)
    const log2encoder = log.sub(`<-Attester to encoder, me: ${account.noisePublicKey.toString('hex').substring(0,5)}, peer: ${key1.toString('hex').substring(0,5)}`)
    const log2hoster = log.sub(`<-Attester to hoster, me: ${account.noisePublicKey.toString('hex').substring(0,5)}, peer: ${key2.toString('hex').substring(0,5)}`)
    
    return new Promise(async (resolve, reject) => {       
      const tid = setTimeout(() => {
        reject({ type: `connect_compare_send timeout` })
      }, DEFAULT_TIMEOUT)
      
      var feed1
      var feed2
      var sentCount = 0
      const chunks = {}
      var proof_of_contact
      
      try {
        // CONNECT TO ENCODER
        log2encoder({ type: 'attester', data: { text: 'load feed', encoder: key1.toString('hex'), topic: topic1.toString('hex') }})
        await hyper.new_task({  newfeed: false, topic: topic1, log: log2encoder })
        
        log2encoder({ type: 'attester', data: { text: 'connect', encoder: key1.toString('hex') }})
        await hyper.connect({ 
          swarm_opts: { role: 'attester2encoder', topic: topic1, mode: { server: false, client: true } }, 
          targets: { targetList: [key1.toString('hex')], ontarget: onencoder,  msg: { receive: { type: 'feedkey' } } },
          log: log2encoder
        })
        // log2encoder({ type: 'attester', data: { text: 'waiting for onencoder', key1: key1.toString('hex') }})
        
        async function onencoder ({ feed, remotestringkey }) {
          log2encoder({ type: 'attester', data: { text: 'Connected to the encoder', encoder: remotestringkey, expectedChunkCount }})
          feed1 = feed
          for (var i = 0; i < expectedChunkCount; i++) {
            get_and_compare(feed1, i)
          }
        }

        async function get_and_compare (feed1, i) {
          try {
            log2encoder({ type: 'attester', data: { text: 'getting chunks', i, expectedChunkCount, key1 } })
            const chunk_promise = feed1.get(i)
            const chunk = await chunk_promise
            const res = await compare_CB(chunk_promise, key1)
            log2encoder({ type: 'attester', data: { text: 'chunk compare res', i, res: res.type, chunk } })
            if (res.type !== 'verified') return reject('error: chunk not valid')
            try_send({ chunk, i, log: log2encoder })
          } catch(err) {
            log2encoder({ type: 'attester', data: { text: 'Error: get_and_compare_chunk' }})
            reject()
          }
        }


        // CONNECT TO HOSTER
        const { feed } = await hyper.new_task({ topic: topic2, log: log2hoster })
        feed2 = feed
        log2hoster({ type: 'attester', data: { text: 'load feed', hoster: key2.toString('hex'), topic: topic2.toString('hex') }})

        await hyper.connect({ 
          swarm_opts: { role: 'attester2hoster', topic: topic2, mode: { server: true, client: false } }, 
          targets: { feed: feed2, targetList: [key2.toString('hex')], ontarget: onhoster, msg: { send: { type: 'feedkey' } }, done } ,
          log: log2hoster
        })
        
        async function onhoster ({ feed, remotestringkey }) {
          log2hoster({ type: 'attester', data: { text: 'connected to the hoster', hoster: remotestringkey, topic: topic2.toString('hex'), chunks }})
          for (var i = 0; i < expectedChunkCount; i++ ) {
            try_send({ i, feed2, log: log2hoster })
          }
        }

        function try_send ({ chunk, i, feed2, log }) {
          if (chunk) { // got chunk in onencoder
            if (!chunks[i]) { 
              chunks[i] = { chunk } 
              log({ type: 'attester', data: { text: 'add chunk to chunks', i }})
            } 
            else {
              chunks[i].send_to_hoster(chunk)
              log({ type: 'attester', data: { text: 'call send_to_hoster cb', i , chunk, cb: chunks[i]}})
              sentCount++
              delete chunks[i]
            }
          }
          else { // onhoster
            if (chunks[i]) {
              feed2.append(chunks[i].chunk)
              log({ type: 'attester', data: { text: 'chunk appended - onhoster', i, sentCount, expectedChunkCount }})
              sentCount++
              delete chunks[i]
            } else { 
              log({ type: 'attester', data: { text: 'add send_to_hoster cb to chunks', i }})
              chunks[i] = { send_to_hoster: (chunk) => { feed2.append(chunk) } } 
            }
          }
          if (sentCount === expectedChunkCount) {
            log({ type: 'attester', data: { text: 'all sent', sentCount, expectedChunkCount }})
            done()
          }
        } 
        
        function done (proof) { // hosting setup
          // called 2x: when all sentCount === expectedChunkCount and when hoster sends proof of contact
          log({ type: 'attester', data: { text: 'done called', proof, sentCount, expectedChunkCount }})
          if (proof) {
            const proof_buff = b4a.from(proof, 'hex')
            const data = b4a.from(unique_el, 'binary')
            if (!datdot_crypto.verify_signature(proof_buff, data, hosterSigningKey)) reject('not valid proof of contact')
            proof_of_contact = proof
          }          
          // if (proof) proof_of_contact = proof
          if (!proof_of_contact) return
          if ((sentCount !== expectedChunkCount)) return
          log({ type: 'attester', data: { text: 'have proof and all data sent', proof, sentCount, expectedChunkCount }})
          clearTimeout(tid)
          done_task_cleanup({ role: 'attester2encoder', topic: topic1, remotestringkey: key1.toString('hex'), state: account.state, log })
          resolve(proof_of_contact)
        }

      } catch(err) {
        log({ type: 'fail', data: { text: 'Error: connect_compare_send', err }})
        clearTimeout(tid)
        reject(err)
      }

    })


  }



  /* ----------------------------------------------------------------------
                          VERIFY STORAGE CHALLENGE
  ---------------------------------------------------------------------- */
  // connect to the hoster (get the feedkey, then start getting data)
  // make a list of all checks (all feedkeys, amendmentIDs...)
  // for each check, get data, verify and make a report => push report from each check into report_all
  // when all checks are done, report to chain
  async function attest_storage_challenge ({ data, account, log: parent_log }) {
    return new Promise(async (resolve, reject) => {
      const tid = setTimeout(() => {
        return reject({ type: `attester_timeout` })
      }, DEFAULT_TIMEOUT)

      const { hyper } = account
      const { id, attesterKey, hosterKey, hosterSigningKey, checks, feedkey_1 } = data
      const logStorageChallenge = parent_log.sub(`<-attester2hoster storage challenge, me: ${attesterKey.toString('hex').substring(0,5)}, peer: ${hosterKey.toString('hex').substring(0,5)}`)
      var reports
      var proof_of_contact
      const verified = [] 
      
      const topic = derive_topic({ senderKey: hosterKey, feedKey: feedkey_1, receiverKey: attesterKey, id, log: logStorageChallenge })
      await hyper.new_task({ newfeed: false, topic, log: logStorageChallenge })
      logStorageChallenge({ type: 'attestor', data: { text: `New task (storage challenge) added` } })

      await hyper.connect({ 
        swarm_opts: { role: 'storage_attester', topic, mode: { server: false, client: true } },
        targets: { targetList: [ hosterKey.toString('hex') ], ontarget: onhoster, msg: { receive: { type: 'feedkey' } }, done },
        log: logStorageChallenge
      })

      function onhoster ({ feed, remotestringkey }) {
        logStorageChallenge({ type: 'attestor', data: { text: `Connected to the storage chalenge hoster`, remotestringkey } })
        get_data(feed)
      }

      async function get_data (feed) {
        try {
          // get chunks from hoster for all the checks
          const contract_ids = Object.keys(checks).map(stringID => Number(stringID))
          for (var i = 0, len = contract_ids.length; i < len; i++) {
            const data_promise = feed.get(i)
            verified.push(verify_chunk(data_promise))
          }
          
          reports = await Promise.all(verified).catch(err => { logStorageChallenge({ type: 'fail', data: err }) })
          if (!reports) logStorageChallenge({ type: 'error', data: [`No reports`] })
          done()
        } catch (err) {
          logStorageChallenge({ type: 'fail', data: { text: 'results error', err } })
          logStorageChallenge({ type: 'error', data: [`Error: ${err}`] })
          clearTimeout(tid)
          // beam.destroy()
          reject({ type: `hoster_proof_fail`, data: err })
        }
      }

      function done (proof) { // storage challenge
        // called 2x: when reports are ready and when hoster sends proof of contact
        // logStorageChallenge({ type: 'attester', data: { text: 'done called for storage challenge', proof, reports, proof_of_contact }})
        if (proof) {
          const proof_buff = b4a.from(proof, 'hex')
          const unique_el = `${id}`
          const data = b4a.from(unique_el, 'binary')
          if (!datdot_crypto.verify_signature(proof_buff, data, hosterSigningKey)) reject('not valid proof of contact')
          proof_of_contact = proof
        }
        if (!proof_of_contact) return
        if ((!reports || reports.length !== Object.keys(checks).length)) return
        logStorageChallenge({ type: 'attester', data: { text: 'have proof and all reports', proof_of_contact, reports_len: reports.length, checks_len: Object.keys(checks).length }})
        clearTimeout(tid)
        done_task_cleanup({ role: 'storage_attester', topic, remotestringkey: hosterKey.toString('hex'), state: account.state, log: logStorageChallenge })
        resolve({ proof_of_contact, reports })
      }

      // @NOTE:
      // attester receives: encoded data, nodes + encoded_data_signature
      // attester verifies signed event
      // attester verifies if chunk is signed by the original encoder (signature, encoder's pubkey, encoded chunk)
      // attester decompresses the chunk and takes out the original data (arr[1])
      // attester merkle verifies the data: (feedkey, root signature from the chain (published by attester after published plan)  )
      // attester sends to the chain: nodes, signature, hash of the data & signed event

      function verify_chunk (chunk_promise) {
        return new Promise(async (resolve, reject) => {
          try {
            const chunk = await chunk_promise
            logStorageChallenge({ type: 'attester', data: { text: `Getting chunk`, chunk } })
            const json = chunk.toString()
            // logStorageChallenge({ type: 'attester', data: { text: `Getting json`, json } })
            const data = proof_codec.decode(json)
            let { contractID, index, encoded_data, encoded_data_signature, p } = data
            logStorageChallenge({ type: 'attester', data: { text: `Storage proof received`, index, contractID, p } })

            const check = checks[`${contractID}`] // { index, feedKey, signatures, ranges, amendmentID, encoder_pos, encoderSigningKey }
            const { index: check_index, feedKey, signatures, ranges, encoderSigningKey, encoder_pos, amendmentID  } = check
            const unique_el = `${amendmentID}/${encoder_pos}`

            if (index !== check_index) reject(index)
            // 1. verify encoder signature
            if (!datdot_crypto.verify_signature(encoded_data_signature, encoded_data, encoderSigningKey)) reject(index)
            logStorageChallenge({ type: 'attester', data: { text: `Encoder sig verified`, index, contractID } })

            // 2. verify proof
            p = proof_codec.to_buffer(p)
            const proof_verified = await datdot_crypto.verify_proof(p, feedKey)
            if (!proof_verified) return reject('not a valid proof')
            logStorageChallenge({ type: 'attester', data: { text: `Proof verified`, index, contractID } })

            // 3. verify chunk (see if hash matches the proof node hash)
            const decompressed = await brotli.decompress(encoded_data)
            const decoded = parse_decompressed(decompressed, unique_el)
            if (!decoded) return reject('parsing decompressed unsuccessful')
            const block_verified = await datdot_crypto.verify_block(p, decoded)
            if (!block_verified) return reject('chunk hash not valid' )
            logStorageChallenge({ type: 'attester', data: { text: `Chunk hash verified`, index, contractID } })
            
            logStorageChallenge({ type: 'attester', data: `Storage verified for ${index}` })
            resolve({ contractID, p: proof_codec.to_string(p) })
          } catch (err) {
            reject('verify chunk failed')
          }
        })
      }

    })
  }

  /* ----------------------------------------------------------------------
                          CHECK PERFORMANCE
  ---------------------------------------------------------------------- */

  async function check_performance ({ account, performanceChallengeID, feed, chunks, hosterkey, topic, log }) {
    log({ type: 'challenge', data: { text: 'checking performance' } })
    return new Promise(async (resolve, reject) => {
      const tid = setTimeout(() => {
        log('performance challenge - timeout')
        reject('performance challenge failed')
      }, DEFAULT_TIMEOUT)
    
      log({ type: 'challenge', data: { text: 'getting stats', data: chunks } })
      const stats = await get_data_and_stats(feed, chunks, log).catch(err => log({ type: 'fail', data: err }))
      // get proof of contact
      await request_proof_of_contact({ account, challenge_id: performanceChallengeID, hosterkey, topic, log })
      clearTimeout(tid)
      log({ type: 'performance check finished', data: { stats: JSON.stringify(stats) } })
      resolve(stats)
    })
  }

  async function request_proof_of_contact ({ account, challenge_id, hosterkey, topic, log }) {
    // request proof
    const remotestringkey = hosterkey.toString('hex')
    const channel = account.state.sockets[remotestringkey].channel
    const stringtopic = topic.toString('hex')
    const string_msg = channel.messages[0]
    log({ type: 'challenge', data: { text: 'requesting proof of contact', challenge_id, stringtopic, remotestringkey } })
    string_msg.send(JSON.stringify({ type: 'requesting-proof-of-contact', challenge_id, stringtopic }))    
    // receiving proof of contact through done cb
  }

  async function get_data_and_stats (feed, chunks, log) {
    log({ type: 'challenge', data: { text: 'Getting data and stats', chunks } })
    return new Promise (async(resolve, reject) => {
      try {
        // const stats = await getStats(feed)
        const stats = {}
        const start = performance.now()

        // log({ type: 'challenge', data: { text: 'Downloading range', chunks: chunks.indexes } })
        // await download_range(feed, chunks.indexes)
        // log({ type: 'challenge', data: { text: 'Range downloaded', index } })
        for (const index of chunks.indexes) {
          log({ type: 'challenge', data: { text: 'Getting data for performance index', index } })
          const data = await feed.get(index)
          log({ type: 'challenge', data: { text: 'Got data for performance check', index } })
          if (!is_verified(data)) return
          log({ type: 'challenge', data: { text: 'Data for performance check verified', index } })
          const end = performance.now()
          const latency = end - start
          stats.latency = stats.latency ? (stats.latency + latency)/2 /* get average latency for all the chunks*/ : latency
        }
        resolve(stats)
      } catch (e) {
        log(`Error: ${feed.key}@${index} ${e.message}`)
        reject(e)
      }

      function is_verified (data) {
        return true
      }

      async function getStats () {
        if (!feed) return {}
        const stats = feed.stats
        const openedPeers = feed.peers.filter(p => p.remoteOpened)
        const networkingStats = {
          key: feed.key,
          discoveryKey: feed.discoveryKey,
          peerCount: feed.peers.length,
          peers: openedPeers.map(p => { return { ...p.stats, remoteAddress: p.remoteAddress }})
        }
        return {
          ...networkingStats,
          uploadedBytes: stats.totals.uploadedBytes,
          uploadedChunks: stats.totals.uploadedBlocks,
          downloadedBytes: stats.totals.downloadedBytes,
          downloadedChunks: feed.downloaded(),
          totalBlocks: feed.length
        }
      }
    })
  }

  // HELPERS

  function getRandomInt (min, max) {
    min = Math.ceil(min)
    max = Math.floor(max)
    return Math.floor(Math.random() * (max - min)) + min // The maximum is exclusive and the minimum is inclusive
  }

}