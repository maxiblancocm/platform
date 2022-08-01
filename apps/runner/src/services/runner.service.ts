import { Definition, IntegrationDefinitionFactory, RunResponse } from '@app/definitions'
import { Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import CryptoJS from 'crypto-js'
import { ObjectId, ObjectID } from 'mongodb'
import { Reference } from '../../../../libs/common/src/typings/mongodb'
import { AccountCredential } from '../../../api/src/account-credentials/entities/account-credential'
import { AccountCredentialService } from '../../../api/src/account-credentials/services/account-credentials.service'
import { IntegrationAccount } from '../../../api/src/integration-accounts/entities/integration-account'
import { IntegrationAccountService } from '../../../api/src/integration-accounts/services/integration-account.service'
import { IntegrationActionService } from '../../../api/src/integration-actions/services/integration-action.service'
import { IntegrationTrigger } from '../../../api/src/integration-triggers/entities/integration-trigger'
import { IntegrationTriggerService } from '../../../api/src/integration-triggers/services/integration-trigger.service'
import { IntegrationService } from '../../../api/src/integrations/services/integration.service'
import { WorkflowAction } from '../../../api/src/workflow-actions/entities/workflow-action'
import { WorkflowActionService } from '../../../api/src/workflow-actions/services/workflow-action.service'
import { WorkflowRun } from '../../../api/src/workflow-runs/entities/workflow-run'
import { WorkflowRunAction } from '../../../api/src/workflow-runs/entities/workflow-run-action'
import { WorkflowRunStartedByOptions } from '../../../api/src/workflow-runs/entities/workflow-run-started-by-options'
import { WorkflowRunStatus } from '../../../api/src/workflow-runs/entities/workflow-run-status'
import { WorkflowSleep } from '../../../api/src/workflow-runs/entities/workflow-sleep'
import { WorkflowRunService } from '../../../api/src/workflow-runs/services/workflow-run.service'
import { WorkflowTrigger } from '../../../api/src/workflow-triggers/entities/workflow-trigger'
import { WorkflowTriggerService } from '../../../api/src/workflow-triggers/services/workflow-trigger.service'
import { Workflow } from '../../../api/src/workflows/entities/workflow'
import { WorkflowService } from '../../../api/src/workflows/services/workflow.service'
import { parseStepInputs } from '../utils/input.utils'
import { extractTriggerItems } from '../utils/trigger.utils'
import { OperationRunnerService, OperationRunOptions } from './operation-runner.service'

@Injectable()
export class RunnerService {
  private readonly logger = new Logger(RunnerService.name)

  constructor(
    private readonly configService: ConfigService,
    private readonly operationRunnerService: OperationRunnerService,
    private readonly integrationService: IntegrationService,
    private readonly integrationAccountService: IntegrationAccountService,
    private readonly integrationActionService: IntegrationActionService,
    private readonly integrationTriggerService: IntegrationTriggerService,
    private readonly workflowService: WorkflowService,
    private readonly workflowActionService: WorkflowActionService,
    private readonly workflowTriggerService: WorkflowTriggerService,
    private readonly workflowRunService: WorkflowRunService,
    private readonly accountCredentialService: AccountCredentialService,
    private readonly integrationDefinitionFactory: IntegrationDefinitionFactory,
  ) {}

  async runWorkflowTriggerCheck(
    workflowTrigger: WorkflowTrigger,
    startedBy: WorkflowRunStartedByOptions,
  ): Promise<void> {
    this.logger.debug(`Checking for trigger ${workflowTrigger.id}`)

    const userId = new ObjectID(workflowTrigger.owner.toString())

    // Make sure the workflow has a first action, otherwise don't run it
    const rootActions = await this.workflowActionService.find({
      workflow: workflowTrigger.workflow,
      isRootAction: true,
    })
    if (!rootActions.length) {
      this.logger.debug(`Trigger ${workflowTrigger.id} doesn't have first action`)
      return
    }

    const integrationTrigger = await this.integrationTriggerService.findById(
      workflowTrigger.integrationTrigger.toString(),
    )
    if (!integrationTrigger) {
      // TODO this should be reported as a ServerError
      throw new NotFoundException(`IntegrationTrigger ${workflowTrigger.integrationTrigger} not found`)
    }

    if (!integrationTrigger.idKey) {
      // TODO this should be reported as a ServerError
      throw new Error(`Tried to run an integration trigger without idKey (id: ${integrationTrigger.id})`)
    }

    const integration = await this.integrationService.findById(integrationTrigger.integration.toString())
    if (!integration) {
      // TODO this should be reported as a ServerError
      throw new NotFoundException(`Integration ${integrationTrigger.integration} not found`)
    }

    const workflowRun = await this.workflowRunService.createOne({
      owner: workflowTrigger.owner,
      workflow: workflowTrigger.workflow,
      status: WorkflowRunStatus.running,
      startedBy,
      triggerRun: {
        integrationName: integration.name,
        operationName: integrationTrigger.name,
        workflowTrigger: workflowTrigger._id,
        status: WorkflowRunStatus.running,
      },
    })

    const { credentials, accountCredential, integrationAccount } = await this.getCredentialsAndIntegrationAccount(
      workflowTrigger.credentials?.toString(),
      () => this.onTriggerFailure(workflowTrigger.workflow, userId, workflowRun, 'Credentials not found'),
    )

    let inputs: Record<string, unknown>
    try {
      inputs = parseStepInputs({ ...workflowTrigger.inputs }, {})
    } catch (e) {
      await this.onTriggerFailure(workflowTrigger.workflow, userId, workflowRun, `Invalid inputs (${e.message})`)
      this.logger.error(`Parse step inputs for ${workflowTrigger.id} failed with error ${e.message}`)
      return
    }

    let runResponse: RunResponse
    const definition = this.integrationDefinitionFactory.getDefinition(integration.parentKey ?? integration.key)
    try {
      runResponse = await this.operationRunnerService.run(definition, {
        integration,
        integrationAccount,
        operation: integrationTrigger,
        inputs,
        credentials,
        accountCredential,
      })
    } catch (e) {
      await this.onTriggerFailure(
        workflowTrigger.workflow,
        userId,
        workflowRun,
        e.message,
        e.response?.text || undefined,
      )
      this.logger.error(`Run WorkflowTrigger ${workflowTrigger.id} failed with error ${e.response?.text ?? e.response}`)
      return
    }

    const triggerItems = extractTriggerItems(integrationTrigger.idKey, runResponse.outputs)
    const triggerIds = triggerItems.map((item) => item.id.toString())

    let newItems: Array<{ id: string | number; item: Record<string, unknown> }> = []
    if (workflowTrigger.lastId) {
      const lastItemIndex = triggerIds.indexOf(workflowTrigger.lastId?.toString())
      // if the last id was not found, we need to trigger for all, otherwise only for new items
      if (lastItemIndex === -1) {
        newItems = triggerItems
      } else {
        newItems = triggerItems.slice(0, lastItemIndex)
      }
    } else {
      newItems = triggerItems.slice(0, 1)
    }

    if (newItems.length === 0) {
      this.logger.debug(`Trigger condition not satisfied for trigger ${workflowTrigger.id}`)
      await this.workflowRunService.markTriggerAsCompleted(userId, workflowRun._id, false, triggerIds.slice(0, 1))
      return
    }

    this.logger.log(`Trigger condition satisfied for trigger ${workflowTrigger.id}`)

    // Populate triggered items if x-triggerPopulate is set
    if (integrationTrigger.triggerPopulate?.operationId) {
      for (const newItem of newItems) {
        const populatedOutputs = await this.populateTrigger(definition, newItem.item, {
          integration,
          integrationAccount,
          operation: integrationTrigger,
          inputs,
          credentials,
          accountCredential,
        })
        newItem.item = {
          ...populatedOutputs,
          ...newItem.item,
        }
      }
    }

    await this.workflowRunService.markTriggerAsCompleted(userId, workflowRun._id, true, triggerIds)
    await this.workflowTriggerService.updateOne(workflowTrigger.id, { lastId: triggerIds[0] })

    const triggerOutputsList = newItems.reverse().map((data) => ({ [workflowTrigger.id]: data.item }))
    await this.runWorkflowActions(rootActions, triggerOutputsList, workflowRun)
  }

  async startWorkflowRun(
    workflowId: ObjectID,
    triggerOutputs: Record<string, Record<string, unknown>>,
    workflowRun: WorkflowRun,
  ): Promise<void> {
    const rootActions = await this.workflowActionService.find({ workflow: workflowId, isRootAction: true })
    await this.runWorkflowActions(rootActions, [triggerOutputs], workflowRun)
  }

  async runWorkflowActions(
    rootActions: WorkflowAction[],
    triggerOutputsList: Array<Record<string, Record<string, unknown>>>,
    workflowRun: WorkflowRun,
  ): Promise<void> {
    for (const triggerOutputs of triggerOutputsList) {
      const promises = rootActions.map((action) => this.runWorkflowActionsTree(action, triggerOutputs, workflowRun))
      await Promise.all(promises)
    }
    await this.workflowRunService.markWorkflowRunAsCompleted(workflowRun._id)
  }

  async runWorkflowActionsTree(
    workflowAction: WorkflowAction,
    previousOutputs: Record<string, Record<string, unknown>>,
    workflowRun: WorkflowRun,
  ): Promise<void> {
    this.logger.log(`Running workflow action ${workflowAction.id} for workflow ${workflowAction.workflow}`)

    const userId = new ObjectID(workflowAction.owner.toString())

    const integrationAction = await this.integrationActionService.findById(workflowAction.integrationAction.toString())
    if (!integrationAction) {
      // TODO this should be reported as a ServerError
      throw new NotFoundException(`IntegrationAction ${workflowAction.integrationAction} not found`)
    }
    const integration = await this.integrationService.findById(integrationAction.integration.toString())
    if (!integration) {
      // TODO this should be reported as a ServerError
      throw new NotFoundException(`Integration ${integrationAction.integration} not found`)
    }

    const workflowRunAction = await this.workflowRunService.addRunningAction(
      workflowRun._id,
      workflowAction._id,
      integration.name,
      integrationAction.name,
    )

    const { credentials, accountCredential, integrationAccount } = await this.getCredentialsAndIntegrationAccount(
      workflowAction.credentials?.toString(),
      () =>
        this.onActionFailure(workflowAction.workflow, userId, workflowRun, workflowRunAction, 'Credentials not found'),
    )

    let inputs: Record<string, unknown>
    try {
      inputs = parseStepInputs({ ...workflowAction.inputs }, previousOutputs)
    } catch (e) {
      await this.onActionFailure(
        workflowAction.workflow,
        userId,
        workflowRun,
        workflowRunAction,
        `Invalid inputs (${e.message})`,
      )
      this.logger.error(`Parse step inputs for ${workflowAction.id} failed with error ${e.message}`)
      return
    }

    let runResponse: RunResponse
    try {
      const definition = this.integrationDefinitionFactory.getDefinition(integration.parentKey ?? integration.key)
      runResponse = await this.operationRunnerService.run(definition, {
        integration,
        integrationAccount,
        operation: integrationAction,
        inputs,
        credentials,
        accountCredential,
      })
      await this.workflowRunService.markActionAsCompleted(userId, workflowRun._id, workflowRunAction)
    } catch (e) {
      await this.onActionFailure(
        workflowAction.workflow,
        userId,
        workflowRun,
        workflowRunAction,
        e.message,
        e.response?.text || undefined,
      )
      this.logger.error(`Run WorkflowAction ${workflowAction.id} failed with error ${e.response?.text ?? e.response}`)
      return
    }

    const nextActionInputs = {
      ...previousOutputs,
      [workflowAction.id]: runResponse.outputs,
    }

    if (runResponse.sleepUntil) {
      await this.workflowRunService.sleepWorkflowRun(
        workflowRun,
        workflowAction,
        nextActionInputs,
        runResponse.sleepUntil,
      )
      return
    }

    // Filter out actions with conditions not met
    const nextActions = (workflowAction.nextActions ?? []).filter((nextAction) => {
      if (!nextAction.condition) {
        return true
      }
      return nextAction.condition === `${runResponse.condition}`
    })

    for (const workflowNextAction of nextActions) {
      const nextAction = await this.workflowActionService.findById(workflowNextAction.action.toString())
      if (!nextAction) {
        throw new Error(`WorkflowAction ${workflowNextAction.action} not found`)
      }
      await this.runWorkflowActionsTree(nextAction, nextActionInputs, workflowRun)
    }
  }

  async getCredentialsAndIntegrationAccount(
    credentialsId: string | undefined,
    onError: () => any,
  ): Promise<{
    credentials: Record<string, string>
    accountCredential: AccountCredential | null
    integrationAccount: IntegrationAccount | null
  }> {
    let integrationAccount: IntegrationAccount | null = null
    let accountCredential: AccountCredential | null = null
    let credentials = {}
    if (credentialsId) {
      accountCredential = (await this.accountCredentialService.findById(credentialsId)) ?? null
      if (!accountCredential) {
        await onError()
        throw new NotFoundException('Account credentials not found')
      }

      const key = this.configService.get('CREDENTIALS_AES_KEY')
      if (!key) {
        throw new InternalServerErrorException('Credentials key not set')
      }
      const decryption = CryptoJS.AES.decrypt(accountCredential.encryptedCredentials, key)
      const unencryptedCredentials = JSON.parse(decryption.toString(CryptoJS.enc.Utf8))
      credentials = {
        ...accountCredential.fields,
        ...unencryptedCredentials,
      }

      if (accountCredential.integrationAccount) {
        integrationAccount =
          (await this.integrationAccountService.findById(accountCredential.integrationAccount.toString())) ?? null
      }
    }
    return { credentials, accountCredential, integrationAccount }
  }

  /**
   * Support x-triggerPopulate OpenAPI extension - Get outputs form populate operation
   */
  async populateTrigger(
    definition: Definition,
    outputs: Record<string, unknown>,
    opts: OperationRunOptions,
  ): Promise<Record<string, unknown>> {
    const triggerPopulate = (opts.operation as IntegrationTrigger).triggerPopulate
    const integrationAction = await this.integrationActionService.findOne({ key: triggerPopulate?.operationId })
    if (triggerPopulate && integrationAction) {
      const parsedInputs = parseStepInputs(triggerPopulate.inputs, {
        inputs: opts.inputs,
        outputs,
      })
      const populateOutputs = await this.operationRunnerService.run(definition, {
        ...opts,
        inputs: parsedInputs,
        operation: integrationAction,
      })
      return populateOutputs.outputs
    }
    return {}
  }

  async wakeUpWorkflowRun(workflowSleep: WorkflowSleep): Promise<void> {
    const workflowRun = await this.workflowRunService.findById(workflowSleep.workflowRun.toString())
    const workflowAction = await this.workflowActionService.findById(workflowSleep.workflowAction.toString())
    if (workflowRun && workflowAction) {
      await this.workflowRunService.wakeUpWorkflowRun(workflowRun)
      const nextActionInputs = (workflowSleep.nextActionInputs ?? {}) as Record<string, Record<string, unknown>>
      const actions = await this.workflowActionService.findByIds(
        workflowAction.nextActions.map((next) => next.action) as ObjectId[],
      )
      const promises = actions.map((action) => this.runWorkflowActionsTree(action, nextActionInputs, workflowRun))
      await Promise.all(promises)
      await this.workflowRunService.markWorkflowRunAsCompleted(workflowRun._id)
    }
  }

  private async onTriggerFailure(
    workflowId: ObjectID | Reference<Workflow, ObjectID>,
    userId: ObjectID,
    workflowRun: WorkflowRun,
    errorMessage: string | undefined,
    errorResponse?: string,
  ): Promise<void> {
    await this.workflowRunService.markTriggerAsFailed(userId, workflowRun, errorMessage, errorResponse)
    await this.runWorkflowOnFailure(workflowId)
  }

  private async onActionFailure(
    workflowId: ObjectID | Reference<Workflow, ObjectID>,
    userId: ObjectID,
    workflowRun: WorkflowRun,
    workflowAction: WorkflowRunAction,
    errorMessage: string | undefined,
    errorResponse?: string,
  ): Promise<void> {
    await this.workflowRunService.markActionAsFailed(userId, workflowRun, workflowAction, errorMessage, errorResponse)
    await this.runWorkflowOnFailure(workflowId)
  }

  private async runWorkflowOnFailure(workflowId: ObjectID | Reference<Workflow, ObjectID>): Promise<void> {
    const workflow = await this.workflowService.findById(workflowId.toString())
    if (workflow?.runOnFailure) {
      const workflowRun = await this.workflowRunService.createOne({
        owner: workflow.owner,
        workflow: workflow.runOnFailure,
        status: WorkflowRunStatus.running,
        startedBy: WorkflowRunStartedByOptions.workflowFailure,
      })
      await this.startWorkflowRun(new ObjectID(workflow.runOnFailure.toString()), {}, workflowRun)
    }
  }
}
