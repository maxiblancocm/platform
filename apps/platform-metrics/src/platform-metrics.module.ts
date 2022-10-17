import { mongoForRoot } from '@app/common/utils/mongodb'
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { AccountCredentialsModule } from 'apps/api/src/account-credentials/account-credentials.module'
import { IntegrationAccountsModule } from 'apps/api/src/integration-accounts/integration-accounts.module'
import { IntegrationActionsModule } from 'apps/api/src/integration-actions/integration-actions.module'
import { IntegrationTriggersModule } from 'apps/api/src/integration-triggers/integration-triggers.module'
import { IntegrationsModule } from 'apps/api/src/integrations/integrations.module'
import { UsersModule } from 'apps/api/src/users/users.module'
import { WorkflowActionsModule } from 'apps/api/src/workflow-actions/workflow-actions.module'
import { WorkflowRunsModule } from 'apps/api/src/workflow-runs/workflow-runs.module'
import { WorkflowTriggersModule } from 'apps/api/src/workflow-triggers/workflow-triggers.module'
import { WorkflowsModule } from 'apps/api/src/workflows/workflows.module'
import { PlatformMetricsService } from './platform-metrics.service'

@Module({
  imports: [
    ConfigModule.forRoot(),
    mongoForRoot(),
    UsersModule,
    IntegrationAccountsModule,
    IntegrationsModule,
    IntegrationTriggersModule,
    IntegrationActionsModule,
    AccountCredentialsModule,
    WorkflowsModule,
    WorkflowTriggersModule,
    WorkflowActionsModule,
    WorkflowRunsModule,
  ],
  providers: [PlatformMetricsService],
})
export class PlatformMetricsModule {}