/**
 * Processor Service
 */

const _ = require('lodash')
const Joi = require('@hapi/joi')
const config = require('config')
const logger = require('../common/logger')
const helper = require('../common/helper')
const IDGenerator = require('../common/IdGenerator')
const constants = require('../constants')
const showdown = require('showdown')
const converter = new showdown.Converter()

const compCategoryIdGen = new IDGenerator('COMPCATEGORY_SEQ')
const compVersionIdGen = new IDGenerator('COMPVERSION_SEQ')
const componentIdGen = new IDGenerator('COMPONENT_SEQ')
const compVersionDatesIdGen = new IDGenerator('COMPVERSIONDATES_SEQ')
const compTechIdGen = new IDGenerator('COMPTECH_SEQ')

/**
 * Prepare Informix statement
 * @param {Object} connection the Informix connection
 * @param {String} sql the sql
 * @return {Object} Informix statement
 */
async function prepare (connection, sql) {
  const stmt = await connection.prepareAsync(sql)
  return Promise.promisifyAll(stmt)
}

/**
 * Insert a record in specified table
 * @param {Object} connection the Informix connection
 * @param {String} tableName the table name
 * @param {Object} columnValues the column key-value map
 */
async function insertRecord (connection, tableName, columnValues) {
  const keys = Object.keys(columnValues)
  const values = _.fill(Array(keys.length), '?')
  const insertRecordStmt = await prepare(connection, `insert into ${tableName} (${keys.join(', ')}) values (${values.join(', ')})`)

  await insertRecordStmt.executeAsync(Object.values(columnValues))
}

/**
 * Update a record in specified table
 * @param {Object} connection the Informix connection
 * @param {String} tableName the table name
 * @param {Object} columnValues the column key-value map
 * @param {String} whereCaluse the where clause
 */
async function updateRecord (connection, tableName, columnValues, whereCaluse) {
  const keys = Object.keys(columnValues)
  const fieldsStatement = keys.map(key => `${key} = ?`).join(', ')
  const updateRecordStmt = await prepare(connection, `update ${tableName} set ${fieldsStatement} where ${whereCaluse}`)

  await updateRecordStmt.executeAsync(Object.values(columnValues))
}

/**
 * Get technologies
 * @param {Object} connection the Informix connection
 * @returns {Array} the technologies
 */
async function getTechnologies (connection) {
  const result = await connection.queryAsync('select technology_type_id as id, technology_name as name from technology_types where status_id = 1')
  _.each(result, e => { e.id = Number(e.id) })
  return result
}

/**
 * Get platforms
 * @param {Object} connection the Informix connection
 * @returns {Array} the platforms
 */
async function getPlatforms (connection) {
  const result = await connection.queryAsync('select project_platform_id as id, name from project_platform_lu')
  _.each(result, e => { e.id = Number(e.id) })
  return result
}

/**
 * Get challenge by id
 * @param {Object} connection the Informix connection
 * @param {Number} id the challenge id
 * @param {Object} the challenge
 */
async function getChallengeById (connection, id) {
  const result = await connection.queryAsync(`select * from project where project_id = ${id}`)
  if (result.length > 0) {
    return result[0]
  } else {
    throw new Error(`Challenge with id: ${id} doesn't existed`)
  }
}

/**
 * Get component version id by challenge id
 * @param {Object} connection the Informix connection
 * @param {Number} challengeId the challenge id
 * @param {Object} the component version id
 */
async function getComponentVersionId (connection, challengeId) {
  const result = await connection.queryAsync(`select value from project_info where project_id = ${challengeId} and project_info_type_id = 1`)
  if (result.length > 0) {
    return Number(result[0].value)
  } else {
    throw new Error(`No component version found for challenge with id: ${challengeId}`)
  }
}

/**
 * Get component id by component version id
 * @param {Object} connection the Informix connection
 * @param {Number} componentVersionId the component version id
 * @param {Object} the component id
 */
async function getComponentId (connection, componentVersionId) {
  const result = await connection.queryAsync(`select component_id from comp_versions where comp_vers_id = ${componentVersionId}`)
  return Number(result[0].component_id)
}

/**
 * Construct DTO from Kafka message payload.
 * @param {Object} payload the Kafka message payload
 * @param {String} m2mToken the m2m token
 * @param {Object} connection the Informix connection
 * @param {Boolean} isCreated flag indicate the DTO is used in creating challenge
 * @returns the DTO for saving a draft contest.(refer SaveDraftContestDTO in ap-challenge-microservice)
 */
async function parsePayload (payload, m2mToken, connection, isCreated = true) {
  try {
    const data = {
      subTrack: payload.track,
      name: payload.name,
      reviewType: payload.reviewType,
      projectId: payload.projectId,
      forumId: payload.forumId
    }
    if (isCreated) {
      // hard code some required properties for v4 api
      data.confidentialityType = 'public'
      data.submissionGuidelines = 'Please read above'
      data.submissionVisibility = true
      data.milestoneId = 1
    }
    if (payload.typeId) {
      const typeRes = await helper.getRequest(`${config.V5_CHALLENGE_TYPE_API_URL}/${payload.typeId}`, m2mToken)
      data.track = typeRes.body.name
    }
    if (payload.description) {
      data.detailedRequirements = payload.markdown ? converter.makeHtml(payload.description) : payload.description
    }
    if (payload.phases) {
      const registrationPhase = _.find(payload.phases, p => p.name.toLowerCase() === constants.phaseTypes.registration)
      const submissionPhase = _.find(payload.phases, p => p.name.toLowerCase() === constants.phaseTypes.submission)
      data.registrationStartsAt = new Date().toISOString()
      data.registrationEndsAt = new Date(Date.now() + registrationPhase.duration).toISOString()
      data.submissionEndsAt = new Date(Date.now() + submissionPhase.duration).toISOString()

      // Only Design can have checkpoint phase and checkpoint prizes
      const checkpointPhase = _.find(payload.phases, p => p.name.toLowerCase() === constants.phaseTypes.checkpoint)
      if (checkpointPhase) {
        data.checkpointSubmissionStartsAt = new Date().toISOString()
        data.checkpointSubmissionEndsAt = new Date(Date.now() + checkpointPhase.duration).toISOString()
      } else {
        data.checkpointSubmissionStartsAt = null
        data.checkpointSubmissionEndsAt = null
      }
    }
    if (payload.prizeSets) {
      // Only Design can have checkpoint phase and checkpoint prizes
      const checkpointPrize = _.find(payload.prizeSets, { type: constants.prizeSetTypes.CheckPoint })
      if (checkpointPrize) {
        // checkpoint prize are the same for each checkpoint submission winner
        data.numberOfCheckpointPrizes = checkpointPrize.prizes.length
        data.checkpointPrize = checkpointPrize.prizes[0].value
      } else {
        data.numberOfCheckpointPrizes = 0
        data.checkpointPrize = 0
      }

      // prize type can be Code/F2F/MM
      const challengePrizes = _.filter(payload.prizeSets, p => p.type !== constants.prizeSetTypes.CheckPoint)
      if (challengePrizes.length > 1) {
        throw new Error('Challenge prize information is invalid.')
      }
      if (challengePrizes.length === 0) {
        // learning challenge has no prizes, for safeguard
        data.prizes = [0]
      } else {
        data.prizes = _.map(challengePrizes[0].prizes, 'value').sort((a, b) => b - a)
      }
    }
    if (payload.tags) {
      const techResult = await getTechnologies(connection)
      data.technologies = _.filter(techResult, e => payload.tags.includes(e.name))

      const platResult = await getPlatforms(connection)
      data.platforms = _.filter(platResult, e => payload.tags.includes(e.name))
    }
    return data
  } catch (err) {
    if (err.status) {
      // extract error message from V5 API
      const message = _.get(err, 'response.body.message')
      throw new Error(message)
    } else {
      throw err
    }
  }
}

/**
 * Get the component category based on challenge track
 * @param {String} track the challenge track
 * @param {Boolean} isStudio the boolean flag indicate the challenge is studio challenge or not
 * @returns {Object} the root category and category of given challenge track
 */
function getCategory (track, isStudio) {
  const result = {}
  result.rootCategory = constants.componentCategories.NotSetParent
  result.category = constants.componentCategories.NotSet
  if (!_.includes(['MARATHON_MATCH', 'DESIGN', 'DEVELOPMENT'], track) && !isStudio) {
    result.rootCategory = constants.componentCategories.Application
    result.category = constants.componentCategories.BusinessLayer
  }
  return result
}

/**
 * Process create challenge message
 * @param {Object} message the kafka message
 */
async function processCreate (message) {
  // initialize informix database connection and m2m token
  const connection = await helper.getInformixConnection()
  const m2mToken = await helper.getM2MToken()

  const saveDraftContestDTO = await parsePayload(message.payload, m2mToken, connection)
  const track = message.payload.track
  const isStudio = constants.projectCategories[track].projectType === constants.projectTypes.Studio
  const category = getCategory(track, isStudio)

  try {
    // begin transaction
    await connection.beginTransactionAsync()

    // generate component id
    const componentId = await componentIdGen.getNextId()

    // insert record into comp_catalog table
    await insertRecord(connection, 'comp_catalog', {
      component_id: componentId,
      current_version: 1,
      short_desc: 'NA',
      component_name: saveDraftContestDTO.name,
      description: 'NA',
      function_desc: 'NA',
      status_id: 102,
      root_category_id: category.rootCategory.id
    })

    // insert record into comp_categories table
    await insertRecord(connection, 'comp_categories', {
      comp_categories_id: await compCategoryIdGen.getNextId(),
      component_id: componentId,
      category_id: category.category.id
    })

    // generate component version id
    const componentVersionId = await compVersionIdGen.getNextId()

    // insert record into comp_versions table
    await insertRecord(connection, 'comp_versions', {
      comp_vers_id: componentVersionId,
      component_id: componentId,
      version: 1,
      version_text: '1.0',
      phase_id: 112,
      phase_time: '1976-05-04 00:00:00', // dummy date value
      price: 0
    })

    // insert record into comp_version_dates table, uses dummy date value
    const dummyDateValue = '2000-01-01'
    await insertRecord(connection, 'comp_version_dates', {
      comp_version_dates_id: await compVersionDatesIdGen.getNextId(),
      comp_vers_id: componentVersionId,
      phase_id: 112,
      total_submissions: 0,
      level_id: 100,
      posting_date: '1976-05-04',
      aggregation_complete_date: dummyDateValue,
      estimated_dev_date: dummyDateValue,
      initial_submission_date: dummyDateValue,
      phase_complete_date: dummyDateValue,
      screening_complete_date: dummyDateValue,
      review_complete_date: dummyDateValue,
      winner_announced_date: dummyDateValue,
      final_submission_date: dummyDateValue,
      production_date: saveDraftContestDTO.registrationStartsAt.slice(0, 10) // convert ISO format to informix date format
    })

    if (!_.includes(['MARATHON_MATCH', 'CONCEPTUALIZATION', 'SPECIFICATION'], track) && !isStudio && saveDraftContestDTO.technologies) {
      for (let tech of saveDraftContestDTO.technologies) {
        // insert record into comp_technology table
        await insertRecord(connection, 'comp_technology', {
          comp_tech_id: await compTechIdGen.getNextId(),
          comp_vers_id: componentVersionId,
          technology_type_id: tech.id
        })
      }
    }

    // commit the transaction
    await connection.commitTransactionAsync()
  } catch (e) {
    await connection.rollbackTransactionAsync()
    throw e
  } finally {
    await connection.closeAsync()
  }
}

processCreate.schema = {
  message: Joi.object().keys({
    topic: Joi.string().required(),
    originator: Joi.string().required(),
    timestamp: Joi.date().required(),
    'mime-type': Joi.string().required(),
    payload: Joi.object().keys({
      id: Joi.string().required(),
      typeId: Joi.string().required(),
      track: Joi.string().required(),
      name: Joi.string().required(),
      description: Joi.string().required(),
      phases: Joi.array().items(Joi.object().keys({
        name: Joi.string().required(),
        duration: Joi.number().positive().required()
      }).unknown(true)).min(1).required(),
      prizeSets: Joi.array().items(Joi.object().keys({
        type: Joi.string().valid(_.values(constants.prizeSetTypes)).required(),
        prizes: Joi.array().items(Joi.object().keys({
          value: Joi.number().positive().required()
        }).unknown(true)).min(1).required()
      }).unknown(true)).min(1).required(),
      reviewType: Joi.string().required(),
      markdown: Joi.boolean().required(),
      tags: Joi.array().items(Joi.string().required()).min(1).required(), // tag names
      projectId: Joi.number().integer().positive().required(),
      forumId: Joi.number().integer().positive().required()
    }).unknown(true).required()
  }).required()
}

/**
 * Process update challenge message
 * @param {Object} message the kafka message
 */
async function processUpdate (message) {
  // initialize informix database connection and m2m token
  const connection = await helper.getInformixConnection()
  const m2mToken = await helper.getM2MToken()

  const saveDraftContestDTO = await parsePayload(message.payload, m2mToken, connection, false)

  try {
    // begin transaction
    await connection.beginTransactionAsync()

    // ensure challenge existed
    const challenge = await getChallengeById(connection, message.payload.legacyId)
    // get the challenge category
    const category = _.find(constants.projectCategories, { id: Number(challenge.project_category_id) })
    // check the challenge is studio challenge
    const isStudio = category.projectType === constants.projectTypes.Studio

    // we can't switch the challenge type
    if (message.payload.track) {
      const newTrack = message.payload.track
      if (constants.projectCategories[newTrack].id !== category.id) {
        // refer ContestDirectManager.prepare in ap-challenge-microservice
        throw new Error(`You can't change challenge type`)
      }
    }

    const isUpdateTechs = !_.includes(['Marathon Match', 'Conceptualization', 'Specification'], category.name) && !isStudio && saveDraftContestDTO.technologies

    if (message.payload.name || isUpdateTechs) {
      const componentVersionId = await getComponentVersionId(connection, Number(challenge.project_id))

      // update component name
      if (message.payload.name) {
        const componentId = await getComponentId(connection, componentVersionId)
        await updateRecord(connection, 'comp_catalog', { component_name: message.payload.name }, `component_id = ${componentId}`)
      }

      // update component technologies
      if (isUpdateTechs) {
        // clear technologies of specified component version first
        await connection.queryAsync(`delete from comp_technology where comp_vers_id = ${componentVersionId}`)

        for (let tech of saveDraftContestDTO.technologies) {
          // insert record into comp_technology table
          await insertRecord(connection, 'comp_technology', {
            comp_tech_id: await compTechIdGen.getNextId(),
            comp_vers_id: componentVersionId,
            technology_type_id: tech.id
          })
        }
      }
    }

    // commit the transaction
    await connection.commitTransactionAsync()
  } catch (e) {
    await connection.rollbackTransactionAsync()
    throw e
  } finally {
    await connection.closeAsync()
  }
}

processUpdate.schema = {
  message: Joi.object().keys({
    topic: Joi.string().required(),
    originator: Joi.string().required(),
    timestamp: Joi.date().required(),
    'mime-type': Joi.string().required(),
    payload: Joi.object().keys({
      legacyId: Joi.number().integer().positive().required(),
      typeId: Joi.string(),
      track: Joi.string(),
      name: Joi.string(),
      description: Joi.string(),
      phases: Joi.array().items(Joi.object().keys({
        name: Joi.string().required(),
        duration: Joi.number().positive().required()
      }).unknown(true)).min(1),
      prizeSets: Joi.array().items(Joi.object().keys({
        type: Joi.string().valid(_.values(constants.prizeSetTypes)).required(),
        prizes: Joi.array().items(Joi.object().keys({
          value: Joi.number().positive().required()
        }).unknown(true)).min(1).required()
      }).unknown(true)).min(1),
      reviewType: Joi.string(),
      markdown: Joi.boolean(),
      tags: Joi.array().items(Joi.string().required()).min(1), // tag names
      projectId: Joi.number().integer().positive(),
      forumId: Joi.number().integer().positive()
    }).unknown(true).required()
  }).required()
}

module.exports = {
  processCreate,
  processUpdate
}

logger.buildService(module.exports)
